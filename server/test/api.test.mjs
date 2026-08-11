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

import { pool, writeSummary, logGeminiCall, writeVideoDuration } from '../src/db.js';
import { parseIso8601Duration } from '../src/youtube.js';

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

  // Signed out, the client no longer refuses locally - it sends an anonymous id
  // and lets the server decide, because whether a video can be read anonymously
  // depends on something the extension is deliberately not told: whether anyone
  // has summarised it yet. Account-only routes still come back 401.
  delete store.sessionToken;
  r = await api.read(video);
  ok('signed out, an account-only route is refused by the server', r && r.code === 'SIGN_IN_REQUIRED');
  ok('and the client minted an anonymous id to ask with', /^[0-9a-f]{32}$/.test(store.anonId || ''));

  const mintedOnce = store.anonId;
  await api.quota();
  ok('which it then keeps rather than re-minting', store.anonId === mintedOnce);
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

// ----------------------------------------------------------------- anonymous

section('anonymous readers: existing summaries only, five a day');
{
  // The extension mints one of these and keeps it in local storage. Forgeable
  // by design - see the schema comment for why that is acceptable here.
  const newAnon = () => randomBytes(16).toString('hex');

  const anonGet = (anonId, path) =>
    fetch(`${BASE}${path}`, { headers: { 'X-YTS-Anon': anonId } }).then(async (r) => ({
      status: r.status,
      ...(await r.json()),
    }));

  const anonStream = async (anonId, videoId) => {
    const res = await fetch(`${BASE}/v1/videos/${videoId}/summary`, {
      method: 'POST',
      headers: { 'X-YTS-Anon': anonId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds: 600 }),
    });
    const events = [];
    for (const block of (await res.text()).split('\n\n')) {
      const e = block.match(/^event: (.+)$/m);
      const d = block.match(/^data: (.+)$/m);
      if (e && d) events.push({ event: e[1], data: JSON.parse(d[1]) });
    }
    return events.at(-1);
  };

  let r = await fetch(`${BASE}/v1/me/quota`, { headers: { 'X-YTS-Anon': 'short' } });
  ok('a malformed anonymous id is not an identity', r.status === 401);

  const anon = newAnon();
  r = await anonGet(anon, '/v1/me/quota');
  ok('a well-formed one is accepted', r.ok === true && r.anonymous === true);
  ok('and reports a daily read count, not minutes', r.anon.limit === 5 && r.anon.used === 0);

  // The headline rule: no summary yet means no generation, ever, anonymously.
  const fresh = newVideoId();
  let done = await anonStream(anon, fresh);
  ok(
    'an unsummarised video asks for an account instead of generating',
    done.data.code === 'SIGN_IN_TO_GENERATE',
    JSON.stringify(done.data)
  );
  ok(
    'and nothing was spent finding that out',
    (await pool.query('SELECT COUNT(*) AS n FROM gemini_calls WHERE video_id = $1', [fresh]))
      .rows[0].n === 0
  );
  ok(
    'a refused generation does not cost a daily read',
    (await anonGet(anon, '/v1/me/quota')).anon.used === 0
  );

  // Five that do exist.
  const seeded = [];
  for (let i = 0; i < 6; i++) {
    const v = newVideoId();
    await writeSummary(v, 1, `# Summary ${i}\n\nBody.`, 'test-model');
    seeded.push(v);
  }

  done = await anonStream(anon, seeded[0]);
  ok('an existing summary is served anonymously', done.event === 'done' && done.data.ok);
  ok('with the text', done.data.markdown.includes('Summary 0'));
  ok('and it counts as one of the five', done.data.anon.used === 1 && done.data.anon.remaining === 4);
  ok('and reveals no stats to an anonymous reader', done.data.stats === null);

  done = await anonStream(anon, seeded[0]);
  ok('re-opening the same video does not cost another', done.data.anon.used === 1);

  for (let i = 1; i < 5; i++) await anonStream(anon, seeded[i]);
  ok('five used', (await anonGet(anon, '/v1/me/quota')).anon.used === 5);

  done = await anonStream(anon, seeded[5]);
  ok('the sixth is refused', done.data.code === 'ANON_LIMIT', JSON.stringify(done.data));
  ok(
    'but one already read today still opens',
    (await anonStream(anon, seeded[0])).data.ok === true
  );

  // Clearing the id gets a fresh five. This is a known, accepted trade: it only
  // ever hands out text that already exists, which costs nothing to serve.
  ok(
    'a fresh id starts over, which is the accepted trade',
    (await anonStream(newAnon(), seeded[5])).data.ok === true
  );

  // Nothing an anonymous caller can reach writes anything owned by a person,
  // and nothing tells them what is in the store.
  ok(
    'per-video stats are refused, so existence cannot be probed',
    (await anonGet(anon, `/v1/videos/${seeded[0]}`)).status === 401
  );
  ok('the owned-video list is empty', (await anonGet(anon, '/v1/me/videos')).videoIds.length === 0);

  const anonPost = (path, body) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'X-YTS-Anon': anon, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.status);

  ok('voting needs an account', (await anonPost(`/v1/videos/${seeded[0]}/vote`, { vote: 'up' })) === 401);
  ok('claiming a view needs an account', (await anonPost(`/v1/videos/${seeded[0]}/view`, { durationSeconds: 60 })) === 401);

  const del = await fetch(`${BASE}/v1/me`, { method: 'DELETE', headers: { 'X-YTS-Anon': anon } });
  ok('there is no anonymous account to erase', del.status === 401);

  // A signed-in user is unaffected by any of this.
  const user = await newUser();
  const signedIn = await stream(user, seeded[0], 600);
  ok(
    'signing in still bills minutes as before',
    signedIn.events.at(-1).data.quota.usedSeconds === 600,
    JSON.stringify(signedIn.events.at(-1).data.quota)
  );
}

// ------------------------------------------------------------------ duration

section('how long a video is, is the server\'s to decide');
{
  // The parser first, because everything below depends on it reading YouTube's
  // contentDetails.duration correctly. P0D is what a live stream reports.
  const cases = [
    ['PT12M34S', 754],
    ['PT1H', 3600],
    ['PT1H2M3S', 3723],
    ['PT30S', 30],
    ['P1DT4H', 100800],
    ['P0D', 0],
    ['', 0],
    ['nonsense', 0],
    [null, 0],
  ];
  for (const [text, expected] of cases) {
    const got = parseIso8601Duration(text);
    ok(`${JSON.stringify(text)} parses as ${expected}s`, got === expected, `got ${got}`);
  }

  // These run without a YOUTUBE_API_KEY, which is the point: they exercise the
  // cached-length path, and a cached length is the one the server trusts. The
  // API call itself is the uninteresting part - what matters is that a number
  // the caller sent is never what gets metered once the server knows better.
  const known = newVideoId();
  await pool.query(
    'INSERT INTO videos (video_id, first_seen_at, duration_seconds) VALUES ($1, $2, $3)',
    [known, Date.now(), 1800]
  );

  const liar = await newUser();
  let r = await post(liar, `/v1/videos/${known}/view`, { durationSeconds: 1 });
  ok(
    'a view is billed the real length, not the claimed one',
    r.quota.usedSeconds === 1800,
    `used=${r.quota?.usedSeconds}`
  );

  // The exploit this closes end to end: claim a video is a second long, get it
  // recorded as viewed for almost nothing, and the summarise path then treats
  // it as already paid for and skips the quota check altogether.
  const long = newVideoId();
  await pool.query(
    'INSERT INTO videos (video_id, first_seen_at, duration_seconds) VALUES ($1, $2, $3)',
    [long, Date.now(), 7200]
  );
  const s = await stream(await newUser(), long, 60);
  ok(
    'a long video is refused however short the caller says it is',
    s.events.at(-1).data.code === 'TOO_LONG',
    JSON.stringify(s.events.at(-1).data)
  );

  const broke = await newUser();
  await burnAllowance(broke);
  r = await post(broke, `/v1/videos/${known}/view`, { durationSeconds: 1 });
  ok(
    'and the allowance cannot be stretched by understating a length',
    r.status === 429 && r.code === 'QUOTA_EXCEEDED',
    `status=${r.status} code=${r.code}`
  );

  // A published video's length does not change, so the first answer stands.
  await writeVideoDuration(known, 60);
  const row = await pool.query('SELECT duration_seconds FROM videos WHERE video_id = $1', [known]);
  ok('a cached length is never revised', row.rows[0].duration_seconds === 1800);

  await writeVideoDuration(newVideoId(), 0);
  ok(
    'and a zero is never cached, so an outage does not pin a video as unsummarisable',
    (await pool.query('SELECT COUNT(*) AS n FROM videos WHERE duration_seconds = 0')).rows[0].n === 0
  );
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
