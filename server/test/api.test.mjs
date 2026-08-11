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

import {
  pool,
  writeSummary,
  logGeminiCall,
  writeVideoDuration,
  getSetting,
  setSetting,
  readDigestStats,
  claimSetting,
  recordIncident,
  readIncidents,
  weekKey,
} from '../src/db.js';
import { parseIso8601Duration } from '../src/youtube.js';
import { formatDigest, measuredUsd, maybeSendDailyDigest, maybeSendSpendAlert } from '../src/digest.js';

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

  // Signed out, the client refuses locally rather than firing a request it
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

section('the allowance rolls over with the week');
{
  const user = await newUser();
  await post(user, `/v1/videos/${newVideoId()}/view`, { durationSeconds: 1800 });
  ok('30 minutes spent this week', (await get(user, '/v1/me/quota')).quota.usedSeconds === 1800);

  // Move the usage into last week's bucket, which is what the passage of time
  // does. readQuota reads the *current* week's row, so the old one goes inert
  // rather than being cleaned up - there is nothing to reset, which is the
  // point of bucketing by week key instead of storing a running total.
  const { week } = (await get(user, '/v1/me/quota')).quota;
  const lastWeek = weekKey(Date.now() - 7 * DAY_MS);
  await pool.query('UPDATE weekly_usage SET week = $1 WHERE user_id = $2 AND week = $3', [
    lastWeek,
    user.userId,
    week,
  ]);

  const fresh = (await get(user, '/v1/me/quota')).quota;
  ok('a new week starts from zero', fresh.usedSeconds === 0, `used=${fresh.usedSeconds}`);
  ok('with the full allowance back', fresh.remainingSeconds === fresh.limitSeconds);
  ok(
    'and last week is still on record, not deleted',
    (await pool.query('SELECT seconds FROM weekly_usage WHERE user_id = $1 AND week = $2', [
      user.userId,
      lastWeek,
    ])).rows[0].seconds === 1800
  );

  // The reset is a real boundary, not a rolling 7 days.
  ok(
    'resetsAt is the coming Monday 00:00 UTC',
    new Date(fresh.resetsAt).getUTCDay() === 1 &&
      new Date(fresh.resetsAt).getUTCHours() === 0,
    new Date(fresh.resetsAt).toISOString()
  );
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

// ------------------------------------------------------------------- digest

section('daily digest and spend alerts');
{
  // The number that matters: 138 generations of ~20 min really cost 29c, so a
  // day of 23 such videos (460 min) should read as ~5c, not the ~20c the
  // token-based estimate would claim.
  ok(
    'prices a day at the measured rate, not the inflated token estimate',
    Math.abs(measuredUsd(460 * 60) - 0.05) < 0.005,
    `got ${measuredUsd(460 * 60)}`
  );
  ok(
    "reproduces the user's own billing: 138 x 20 min ~= 29c",
    Math.abs(measuredUsd(138 * 20 * 60) - 0.29) < 0.02,
    `got ${measuredUsd(138 * 20 * 60)}`
  );

  ok(
    'formats a report from stats alone, no I/O involved',
    formatDigest('2026-08-11', {
      capped_usd: 0.183,
      duration_seconds: 460 * 60,
      generations: 23,
      new_users: 2,
      reads: 37,
      active_readers: 14,
    }) ===
      'YTS daily report — 2026-08-11 (UTC)\n' +
        'Spend: ~5.0c · 23 generations · 460 min of video\n' +
        'New sign-ups: 2\n' +
        'Opened: 37 by 14 people'
  );
  ok(
    'mentions the cap only once spend approaches it',
    !formatDigest('2026-08-11', {
      capped_usd: 0.1, duration_seconds: 600, generations: 1, new_users: 0, reads: 1, active_readers: 1,
    }).includes('cap') &&
      formatDigest('2026-08-11', {
        capped_usd: 1.2, duration_seconds: 600, generations: 1, new_users: 0, reads: 1, active_readers: 1,
      }).includes('Against the $2.00 cap')
  );
  ok(
    'singular forms when the count is one',
    formatDigest('2026-08-11', {
      capped_usd: 0.01, duration_seconds: 600, generations: 1, new_users: 0, reads: 1, active_readers: 1,
    }).includes('1 generation ') &&
      formatDigest('2026-08-11', {
        capped_usd: 0, duration_seconds: 0, generations: 0, new_users: 0, reads: 1, active_readers: 1,
      }).includes('1 person')
  );

  // maybeSendDailyDigest/maybeSendSpendAlert both no-op without Telegram
  // configured, which is exactly the state this test suite runs in - so what
  // is actually exercised here is that "no token" means "does nothing", not
  // "throws", and that the settings-based bookkeeping underneath is sound.
  await setSetting('digest_last_day', 'unset-marker');
  await maybeSendDailyDigest();
  ok(
    'without Telegram configured, nothing is sent and nothing is claimed',
    (await getSetting('digest_last_day')) === 'unset-marker'
  );

  await setSetting('spend_alert_level', '0');
  await maybeSendSpendAlert();
  ok(
    'same for the spend alert - it does not silently mark itself done',
    (await getSetting('spend_alert_level')) === '0'
  );

  // The claim is what stops two instances both sending the same report. First
  // caller wins; every later one is told the day is already spoken for.
  await setSetting('claim-probe', 'day-1');
  ok('re-claiming the same value is refused', (await claimSetting('claim-probe', 'day-1')) === false);
  ok('claiming a new value succeeds', (await claimSetting('claim-probe', 'day-2')) === true);
  ok('and only once', (await claimSetting('claim-probe', 'day-2')) === false);
  await pool.query("DELETE FROM settings WHERE key = 'claim-probe'");

  // readDigestStats itself has no such guard - it is a plain read, and this is
  // what proves the query counts the right things in the right window.
  const dayStart = Date.now() - 2 * DAY_MS;
  const dayEnd = dayStart + DAY_MS;
  const video = newVideoId();
  await logGeminiCall({
    videoId: video,
    userId: 'digest-test',
    durationSeconds: 60,
    cost: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalUsd: 0.05 },
  });
  await pool.query('UPDATE gemini_calls SET created_at = $1 WHERE video_id = $2', [
    dayStart + 1000,
    video,
  ]);
  const before = await readDigestStats(dayStart, dayStart);
  const inside = await readDigestStats(dayStart, dayEnd);
  ok(
    'the window picks up a call placed inside it',
    inside.generations === before.generations + 1,
    `before=${before.generations} inside=${inside.generations}`
  );
  ok(
    'and sums its cost',
    Math.abs(inside.capped_usd - before.capped_usd - 0.05) < 1e-9,
    `before=${before.capped_usd} inside=${inside.capped_usd}`
  );

  await pool.query('DELETE FROM gemini_calls WHERE user_id = $1', ['digest-test']);
}

// ---------------------------------------------------------------- incidents

section('critical failures: counted always, alerted once a day');
{
  const day = new Date().toISOString().slice(0, 10);
  await pool.query('DELETE FROM incidents WHERE kind LIKE $1', ['test-%']);

  ok('the first of a kind starts at one', (await recordIncident('test-a', 'boom')) === 1);
  ok('a repeat folds into the same row', (await recordIncident('test-a', 'boom again')) === 2);
  ok('a different kind is its own row', (await recordIncident('test-b', 'other')) === 1);

  const rows = await readIncidents(day);
  const a = rows.find((r) => r.kind === 'test-a');
  ok('the row keeps the latest message, not the first', a.sample === 'boom again');
  ok('and the running count', a.count === 2);
  ok('worst first', rows[0].count >= rows[rows.length - 1].count);

  // Five hundred failures of the same kind must not be five hundred rows -
  // the second one tells you nothing the first did not.
  for (let i = 0; i < 20; i++) await recordIncident('test-a', `burst ${i}`);
  const still = await pool.query('SELECT COUNT(*) AS n FROM incidents WHERE kind = $1', ['test-a']);
  ok('a storm is still one row', still.rows[0].n === 1);

  // The one-a-day rule, which is the whole point: the claim is per day and
  // across every kind, so a second failure of any sort stays quiet.
  await pool.query("DELETE FROM settings WHERE key = 'incident_alert_day'");
  ok('the first failure of the day claims the alert', (await claimSetting('incident_alert_day', day)) === true);
  ok('every later one that day is silent', (await claimSetting('incident_alert_day', day)) === false);
  ok(
    'and tomorrow can speak again',
    (await claimSetting('incident_alert_day', '2099-01-01')) === true
  );

  // A day with no traffic but a broken service is exactly when the report
  // matters most, so incidents alone are enough to make it send.
  const withProblem = formatDigest(
    day,
    { capped_usd: 0, duration_seconds: 0, generations: 0, new_users: 0, reads: 0, active_readers: 0 },
    2,
    [{ kind: 'youtube-layout-changed', count: 12, sample: 'cardSelector matched 0' }]
  );
  ok('the report carries the problem and its detail', withProblem.includes('youtube-layout-changed ×12 — cardSelector matched 0'));
  ok('flagged so it cannot be skimmed past', withProblem.includes('⚠ 1 problem'));

  await pool.query('DELETE FROM incidents WHERE kind LIKE $1', ['test-%']);
  await pool.query("DELETE FROM settings WHERE key = 'incident_alert_day'");
}

// -------------------------------------------------------------- telemetry

section('the extension can report that YouTube changed');
{
  const user = await newUser();
  const day = new Date().toISOString().slice(0, 10);
  await pool.query('DELETE FROM incidents WHERE kind = $1', ['youtube-layout-changed']);

  let r = await post(user, '/v1/telemetry', {
    kind: 'selectors',
    surface: 'home',
    detail: 'cardSelector "ytd-rich-item-renderer" matched 0 of YouTube\'s rendered videos at /',
  });
  ok('a layout report is accepted', r.status === 202 && r.ok === true);

  const rows = await readIncidents(day);
  const hit = rows.find((x) => x.kind === 'youtube-layout-changed');
  ok('and lands as a critical incident', !!hit, JSON.stringify(rows.map((x) => x.kind)));
  ok('naming the surface that broke', hit.sample.includes('home'));
  ok('and the selector that stopped matching', hit.sample.includes('ytd-rich-item-renderer'));

  r = await post(user, '/v1/telemetry', { kind: 'something-else', detail: 'x' });
  ok('unknown telemetry kinds are refused', r.status === 400);

  const anon = await fetch(`${BASE}/v1/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'selectors', detail: 'x' }),
  });
  ok('and it is not an open endpoint', anon.status === 401);

  await pool.query('DELETE FROM incidents WHERE kind = $1', ['youtube-layout-changed']);
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
