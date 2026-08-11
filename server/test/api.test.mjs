// Integration tests. These run against a live server and the extension's real
// background/api.js - the point is to check the contract between the two, so
// there is nothing mocked except chrome.*.
//
//   cd server && npm start        # in one terminal
//   cd server && npm test         # in another
//
// Sessions are created by writing to the database directly rather than through
// a test-only endpoint. A backdoor that mints sessions is a backdoor whether or
// not it is labelled one, and this needs no such thing to exist in production.

import { randomBytes, createHash } from 'node:crypto';

import { pool, writeSummary, logGeminiCall } from '../src/db.js';

const BASE = process.env.YTS_TEST_BASE || 'http://localhost:8787';
const DAY_MS = 86400000;

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};
const section = (name) => console.log(`\n--- ${name}`);

// A fresh 11-character url-safe id, matching YouTube's format.
const newVideoId = () => randomBytes(8).toString('hex').slice(0, 11);

// A signed-in user. Returns the bearer token the extension would hold.
// Passing an explicit userId is how "the same Google account signs in again"
// is simulated: Google's `sub` is stable, so a returning person lands on the
// same row they had before.
async function newUser(plan = 'free', userId = `test-${randomBytes(8).toString('hex')}`) {
  const token = randomBytes(24).toString('base64url');
  const now = Date.now();
  await pool.query(
    'INSERT INTO users (user_id, email, plan, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $4)',
    [userId, `${userId}@example.test`, plan, now]
  );
  await pool.query(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [token, userId, now, now + DAY_MS]
  );
  return { token, userId };
}

const get = (user, path) =>
  fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${user.token}` } }).then((r) =>
    r.json()
  );

const post = (user, path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

// Reads an SSE response into a list of {event, data}.
const stream = async (user, videoId, durationSeconds) => {
  const res = await fetch(`${BASE}/v1/videos/${videoId}/summary`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationSeconds }),
  });
  const events = [];
  for (const block of (await res.text()).split('\n\n')) {
    const e = block.match(/^event: (.+)$/m);
    const d = block.match(/^data: (.+)$/m);
    if (e && d) events.push({ event: e[1], data: JSON.parse(d[1]) });
  }
  return { status: res.status, contentType: res.headers.get('content-type'), events };
};

// Spends a user's whole allowance. Takes the remaining balance each round
// rather than assuming the quota divides evenly into equal videos - the server
// refuses anything larger than what is left, so a fixed chunk size stalls with
// a remainder still on the clock.
async function burnAllowance(user) {
  for (;;) {
    const { remainingSeconds } = (await get(user, '/v1/me/quota')).quota;
    if (remainingSeconds === 0) return;
    await post(user, `/v1/videos/${newVideoId()}/view`, {
      durationSeconds: Math.min(3600, remainingSeconds),
    });
  }
}

// ---------------------------------------------------------------------- auth

section('authentication');
{
  let res = await fetch(`${BASE}/v1/me/quota`);
  ok('no token is rejected', res.status === 401);

  res = await fetch(`${BASE}/v1/me/quota`, { headers: { Authorization: 'Bearer nonsense' } });
  ok('an invented token is rejected', res.status === 401);

  res = await fetch(`${BASE}/v1/me/quota`, { headers: { Authorization: 'notbearer x' } });
  ok('a malformed header is rejected', res.status === 401);

  const user = await newUser();
  ok('a real session works', (await get(user, '/v1/me/quota')).ok === true);

  // An expired session must stop working, and stop existing.
  const expired = await newUser();
  await pool.query('UPDATE sessions SET expires_at = $1 WHERE token = $2', [
    Date.now() - 1000,
    expired.token,
  ]);
  res = await fetch(`${BASE}/v1/me/quota`, {
    headers: { Authorization: `Bearer ${expired.token}` },
  });
  ok('an expired session is rejected', res.status === 401);
  const left = await pool.query('SELECT 1 FROM sessions WHERE token = $1', [expired.token]);
  ok('and is deleted on the way out', left.rowCount === 0);

  // Signing out revokes immediately - the whole reason for opaque tokens over
  // signed ones.
  const bye = await newUser();
  await fetch(`${BASE}/v1/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bye.token}` },
  });
  res = await fetch(`${BASE}/v1/me/quota`, { headers: { Authorization: `Bearer ${bye.token}` } });
  ok('signing out revokes the session at once', res.status === 401);

  const me = await get(user, '/v1/me');
  ok('/v1/me reports the account', me.ok && me.user.email.endsWith('@example.test'));
  ok('and its plan', me.user.plan === 'free');

  ok('health still needs no auth', (await fetch(`${BASE}/v1/health`)).status === 200);
}

// ---------------------------------------------------------------- api client

section('extension api.js client');
{
  const user = await newUser();
  const store = { serviceUrl: BASE, sessionToken: user.token };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) {
          Object.assign(store, obj);
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        },
      },
    },
    identity: { getRedirectURL: () => 'https://example.chromiumapp.org/' },
  };

  const { api, isConfigured } = await import('../../background/api.js');
  const video = newVideoId();

  ok('reports itself configured', await isConfigured());

  let r = await api.read(video);
  ok('read returns stats and quota together', !!(r?.ok && r.stats && r.quota));

  const before = r.quota.usedSeconds;
  r = await api.view(video, 900);
  ok('view bills the video length', r.quota.usedSeconds === before + 900);

  r = await api.view(video, 900);
  ok('a repeat view is not billed twice', r.quota.usedSeconds === before + 900);

  // Signed out, the client must refuse locally rather than firing a request it
  // knows will 401.
  delete store.sessionToken;
  r = await api.read(video);
  ok('no session short-circuits to SIGN_IN_REQUIRED', r && r.code === 'SIGN_IN_REQUIRED');
  store.sessionToken = user.token;

  store.serviceUrl = 'http://localhost:9';
  ok('unreachable service degrades to null', (await api.read(video)) === null);
  store.serviceUrl = '';
  ok('unconfigured service returns null', (await api.read(video)) === null);
}

// ------------------------------------------------------------------- billing

section('a cached summary still costs the reader, unless it is theirs');
{
  const video = newVideoId();
  const duration = 600;
  const alice = await newUser();
  const bob = await newUser();

  ok('alice has not viewed it', (await get(alice, `/v1/videos/${video}`)).stats.youViewed === false);

  let r = await post(alice, `/v1/videos/${video}/view`, { durationSeconds: duration });
  ok('alice is billed', r.quota.usedSeconds === duration);

  r = await get(alice, `/v1/videos/${video}`);
  ok('alice now sees it as hers, so the button reads "Summarised"', r.stats.youViewed === true);

  r = await post(alice, `/v1/videos/${video}/view`, { durationSeconds: duration });
  ok('alice re-opening her own is free', r.quota.usedSeconds === duration);

  r = await get(bob, `/v1/videos/${video}`);
  ok('bob sees it as not his, so the button reads "Summarise"', r.stats.youViewed === false);

  r = await post(bob, `/v1/videos/${video}/view`, { durationSeconds: duration });
  ok('bob is billed for a summary he did not generate', r.quota.usedSeconds === duration);
  ok('bob is counted in the total', r.stats.summarisedBy === 2);
  ok('alice sees one other person', (await get(alice, `/v1/videos/${video}`)).stats.others === 1);
}

// --------------------------------------------------------------------- quota

section('weekly quota');
{
  const user = await newUser();
  await burnAllowance(user);
  ok('allowance is spent', (await get(user, '/v1/me/quota')).quota.remainingSeconds === 0);

  let r = await post(user, `/v1/videos/${newVideoId()}/view`, { durationSeconds: 3600 });
  ok('a new video is refused with 429', r.status === 429 && r.code === 'QUOTA_EXCEEDED');

  const owned = newVideoId();
  await post(await newUser(), `/v1/videos/${owned}/view`, { durationSeconds: 60 });
  const poor = await newUser();
  await post(poor, `/v1/videos/${owned}/view`, { durationSeconds: 60 });
  await burnAllowance(poor);
  r = await post(poor, `/v1/videos/${owned}/view`, { durationSeconds: 60 });
  ok('a video they already paid for still opens when out of quota', r.status === 200);
}

section('the unlimited plan');
{
  const friend = await newUser('unlimited');
  const q = (await get(friend, '/v1/me/quota')).quota;
  ok('reports as unlimited', q.unlimited === true);

  // Well past what a free account gets in a week.
  for (let i = 0; i < 8; i++) {
    await post(friend, `/v1/videos/${newVideoId()}/view`, { durationSeconds: 3600 });
  }
  const after = (await get(friend, '/v1/me/quota')).quota;
  ok('usage is still counted', after.usedSeconds === 8 * 3600, `used=${after.usedSeconds}`);
  ok('but never exhausted', after.unlimited === true);

  const r = await post(friend, `/v1/videos/${newVideoId()}/view`, { durationSeconds: 3600 });
  ok('and never refused', r.status === 200);
}

// ------------------------------------------------------------------- erasure

section('erasure does not refill the allowance');
{
  const user = await newUser();
  await post(user, `/v1/videos/${newVideoId()}/view`, { durationSeconds: 1800 });
  ok('30 minutes spent', (await get(user, '/v1/me/quota')).quota.usedSeconds === 1800);

  const res = await fetch(`${BASE}/v1/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${user.token}` },
  });
  ok('deletion succeeds', res.status === 200);

  // Same Google account signing up again: same user_id, so the same salted
  // hash, so the week it already spent is still spent.
  const salt = (await pool.query("SELECT value FROM settings WHERE key = 'user_hash_salt'"))
    .rows[0].value;
  const hash = createHash('sha256').update(salt).update(user.userId).digest('hex');
  const retained = await pool.query(
    'SELECT seconds FROM retired_usage WHERE user_hash = $1',
    [hash]
  );
  ok('the spent week is retained against a hash', retained.rows[0]?.seconds === 1800);

  const reborn = await newUser('free', user.userId);
  const back = (await get(reborn, '/v1/me/quota')).quota;
  ok('signing up again does not hand back the week', back.usedSeconds === 1800, `used=${back.usedSeconds}`);

  const identifiable = await pool.query(
    'SELECT (SELECT COUNT(*) FROM views WHERE user_id = $1) AS v, (SELECT COUNT(*) FROM weekly_usage WHERE user_id = $1) AS u',
    [user.userId]
  );
  ok('and the identifiable rows are gone', identifiable.rows[0].v === 0 && identifiable.rows[0].u === 0);
}

// --------------------------------------------------------------- summarising

section('summarise endpoint');
{
  const alice = await newUser();
  const bob = await newUser();
  const video = newVideoId();

  let r = await stream(alice, video, 600);
  ok('responds as an event stream', r.contentType?.includes('text/event-stream'));
  ok(
    'refuses over the length cap',
    (await stream(alice, newVideoId(), 99999)).events.at(-1).data.code === 'TOO_LONG'
  );

  // A zero duration used to pass every gate: under the length cap, and
  // commitView only bills when seconds > 0. That made an unknown duration a
  // free, uncapped summary of a video of any length.
  for (const bad of [0, -5, null, undefined, 'nonsense']) {
    const res = await stream(await newUser(), newVideoId(), bad);
    const last = res.events.at(-1);
    ok(
      `duration ${JSON.stringify(bad)} is refused, not billed as zero`,
      last && last.data.code === 'UNKNOWN_DURATION',
      last ? last.data.code : `no events, HTTP ${res.status}`
    );
  }

  const cheat = await newUser();
  const cheatVideo = newVideoId();
  await stream(cheat, cheatVideo, 0);
  ok(
    'a refused request records nothing',
    (await get(cheat, `/v1/videos/${cheatVideo}`)).stats.youViewed === false
  );
  ok('and bills nothing', (await get(cheat, '/v1/me/quota')).quota.usedSeconds === 0);

  // Seed a summary as though someone had already generated it.
  await writeSummary(video, 1, '# Already written\n\nBody.', 'test-model');

  r = await stream(alice, video, 600);
  let done = r.events.at(-1);
  ok('an existing summary is served', done.event === 'done' && done.data.ok);
  ok('and is NOT regenerated', done.data.generated === false);
  ok('it arrives whole, with no delta events', !r.events.some((e) => e.event === 'delta'));
  ok('alice is billed for reading it', done.data.quota.usedSeconds === 600);

  r = await stream(alice, video, 600);
  ok('alice re-reading her own is free', r.events.at(-1).data.quota.usedSeconds === 600);

  r = await stream(bob, video, 600);
  done = r.events.at(-1);
  ok('bob gets the same summary', done.data.markdown.includes('Already written'));
  ok('bob is billed for it too', done.data.quota.usedSeconds === 600);
  ok('the counter now shows two people', done.data.stats.summarisedBy === 2);

  // The spend cap. Log a call that blows through it, then confirm a video with
  // no existing summary is refused before Gemini is touched.
  const capUser = await newUser();
  await logGeminiCall({
    videoId: newVideoId(),
    userId: capUser.userId,
    durationSeconds: 60,
    cost: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalUsd: 999 },
  });
  try {
    r = await stream(await newUser(), newVideoId(), 600);
    ok(
      'a new generation is refused once the cap is hit',
      r.events.at(-1).data.code === 'SPEND_CAP',
      JSON.stringify(r.events.at(-1).data)
    );

    // Crucially, already-generated summaries keep working - the cap stops new
    // spending, it does not take the service down.
    r = await stream(await newUser(), video, 600);
    ok('existing summaries still serve under the cap', r.events.at(-1).data.ok === true);
  } finally {
    await pool.query('DELETE FROM gemini_calls WHERE user_id = $1', [capUser.userId]);
  }

  r = await stream(await newUser(), newVideoId(), 600);
  ok('once under the cap again, it reaches the key check', r.events.at(-1).data.code === 'NO_API_KEY');
}

// ------------------------------------------------------------ crowd re-runs

section('downvote threshold, capped at one rewrite');
{
  const video = newVideoId();
  const vote = async (user, v) => post(user, `/v1/videos/${video}/vote`, { vote: v });

  const fan = await newUser();
  let r = await vote(fan, 'up');
  ok('an upvote is recorded', r.stats.up === 1 && r.stats.yourVote === 'up');

  const critics = [await newUser(), await newUser(), await newUser()];
  r = await vote(critics[0], 'down');
  ok('one downvote does nothing', r.retired === false);
  r = await vote(critics[1], 'down');
  ok('two downvotes do nothing', r.retired === false, `down=${r.stats.down}`);

  r = await vote(critics[2], 'down');
  ok('the third downvote retires the summary', r.retired === true);
  ok('the video moves to revision 2', r.revision === 2, `rev=${r.revision}`);
  ok('the tally resets for the rewrite', r.stats.up === 0 && r.stats.down === 0);
  ok('votes on the retired revision do not carry over', r.stats.yourVote === null);

  for (let i = 0; i < 3; i++) r = await vote(await newUser(), 'down');
  ok('the rewrite is not retired in turn', r.retired === false);
  ok('revision stays capped at 2', r.revision === 2, `rev=${r.revision}`);
  ok('it is reported as exhausted', r.exhausted === true);

  r = await vote(await newUser(), 'down');
  ok('piling on changes nothing', r.retired === false && r.revision === 2);
  ok('but downvotes still tally as a signal', r.stats.down === 4, `down=${r.stats.down}`);

  const flipper = await newUser();
  await vote(flipper, 'up');
  r = await vote(flipper, null);
  ok('clearing a vote works', r.stats.yourVote === null);
}

// ------------------------------------------------------------------ rejects

section('input validation');
{
  const user = await newUser();
  const res = await fetch(`${BASE}/v1/videos/short`, {
    headers: { Authorization: `Bearer ${user.token}` },
  });
  ok('a malformed videoId is rejected', res.status === 400);
}

await pool.end();
console.log(`\n${failures === 0 ? 'all tests passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
