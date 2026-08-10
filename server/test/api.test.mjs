// Integration tests. These run against a live server and the extension's real
// background/api.js - the point is to check the contract between the two, so
// there is nothing mocked except chrome.storage.
//
//   cd server && npm start        # in one terminal
//   cd server && npm test         # in another
//
// Every test mints its own random videoId and user ids, so the suite is
// re-runnable against a database that already has data in it.

const BASE = process.env.YTS_TEST_BASE || 'http://localhost:8787';

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};
const section = (name) => console.log(`\n--- ${name}`);

// A fresh 11-character url-safe id, matching YouTube's format.
const newVideoId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 11);

const get = (user, path) =>
  fetch(`${BASE}${path}`, { headers: { 'X-Yts-User': user } }).then((r) => r.json());

const post = (user, path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'X-Yts-User': user, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

// ---------------------------------------------------------------- api client

section('extension api.js client');
{
  const store = { serviceUrl: BASE };
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
      },
    },
  };

  const { api, ensureUserId, isConfigured } = await import('../../background/api.js');
  const video = newVideoId();

  ok('reports itself configured', await isConfigured());
  const me = await ensureUserId();
  ok('mints a uuid', /^[0-9a-f-]{36}$/.test(me));
  ok('reuses the same uuid', (await ensureUserId()) === me);

  let r = await api.read(video);
  ok('read returns stats and quota together', !!(r?.ok && r.stats && r.quota));

  const before = r.quota.usedSeconds;
  r = await api.view(video, 900);
  ok('view bills the video length', r.quota.usedSeconds === before + 900);

  r = await api.view(video, 900);
  ok('a repeat view is not billed twice', r.quota.usedSeconds === before + 900);

  // The service being absent or down must never break a summary.
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
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();

  ok('alice has not viewed it', (await get(alice, `/v1/videos/${video}`)).stats.youViewed === false);

  let r = await post(alice, `/v1/videos/${video}/view`, { durationSeconds: duration });
  ok('alice is billed', r.quota.usedSeconds === duration);

  r = await get(alice, `/v1/videos/${video}`);
  ok('alice now sees it as hers, so the button reads "Summarised"', r.stats.youViewed === true);

  r = await post(alice, `/v1/videos/${video}/view`, { durationSeconds: duration });
  ok('alice re-opening her own is free', r.quota.usedSeconds === duration);

  // Bob did not generate this summary. Reading it still costs him.
  r = await get(bob, `/v1/videos/${video}`);
  ok('bob sees it as not his, so the button reads "Summarise"', r.stats.youViewed === false);

  r = await post(bob, `/v1/videos/${video}/view`, { durationSeconds: duration });
  ok('bob is billed for reading a summary he did not generate', r.quota.usedSeconds === duration);
  ok('bob is counted in the total', r.stats.summarisedBy === 2);
  ok('alice sees one other person', (await get(alice, `/v1/videos/${video}`)).stats.others === 1);
}

// -------------------------------------------------------------------- quota

section('weekly quota');
{
  // Spends a user's whole allowance. Takes the remaining balance each round
  // rather than assuming the quota divides evenly into equal videos - the
  // server refuses anything larger than what is left, so a fixed chunk size
  // stalls with a remainder still on the clock.
  const burnAllowance = async (user) => {
    for (;;) {
      const { remainingSeconds } = (await get(user, '/v1/me/quota')).quota;
      if (remainingSeconds === 0) return;
      await post(user, `/v1/videos/${newVideoId()}/view`, {
        durationSeconds: Math.min(3600, remainingSeconds),
      });
    }
  };

  const user = crypto.randomUUID();
  await burnAllowance(user);
  ok('allowance is spent', (await get(user, '/v1/me/quota')).quota.remainingSeconds === 0);

  const fresh = newVideoId();
  let r = await post(user, `/v1/videos/${fresh}/view`, { durationSeconds: 3600 });
  ok('a new video is refused with 429', r.status === 429 && r.code === 'QUOTA_EXCEEDED');

  // Already paid for: still readable, because re-opening it was never billable.
  const owned = newVideoId();
  await post(crypto.randomUUID(), `/v1/videos/${owned}/view`, { durationSeconds: 60 });
  const poor = crypto.randomUUID();
  await post(poor, `/v1/videos/${owned}/view`, { durationSeconds: 60 });
  await burnAllowance(poor);
  r = await post(poor, `/v1/videos/${owned}/view`, { durationSeconds: 60 });
  ok('a video they already paid for still opens when out of quota', r.status === 200);
}

// ------------------------------------------------------------ crowd re-runs

section('downvote threshold, capped at one rewrite');
{
  const video = newVideoId();
  const vote = (user, v) => post(user, `/v1/videos/${video}/vote`, { vote: v });

  const fan = crypto.randomUUID();
  let r = await vote(fan, 'up');
  ok('an upvote is recorded', r.stats.up === 1 && r.stats.yourVote === 'up');

  // Two downvotes are not enough - the floor is three, whatever the ratio.
  const critics = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  r = await vote(critics[0], 'down');
  ok('one downvote does nothing', r.retired === false);
  r = await vote(critics[1], 'down');
  ok('two downvotes do nothing', r.retired === false, `down=${r.stats.down}`);

  r = await vote(critics[2], 'down');
  ok('the third downvote retires the summary', r.retired === true);
  ok('the video moves to revision 2', r.revision === 2, `rev=${r.revision}`);
  ok('the tally resets for the rewrite', r.stats.up === 0 && r.stats.down === 0);
  ok('votes on the retired revision do not carry over', r.stats.yourVote === null);

  // The rewrite gets rejected too. It does not get a second rewrite.
  for (const u of [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]) {
    r = await vote(u, 'down');
  }
  ok('the rewrite is not retired in turn', r.retired === false);
  ok('revision stays capped at 2', r.revision === 2, `rev=${r.revision}`);
  ok('it is reported as exhausted', r.exhausted === true);

  r = await vote(crypto.randomUUID(), 'down');
  ok('piling on changes nothing', r.retired === false && r.revision === 2);
  ok('but downvotes still tally as a signal', r.stats.down === 4, `down=${r.stats.down}`);

  // Toggling your own vote off.
  const flipper = crypto.randomUUID();
  await vote(flipper, 'up');
  r = await vote(flipper, null);
  ok('clearing a vote works', r.stats.yourVote === null);
}

// --------------------------------------------------------------- summarising

section('summarise endpoint');
{
  // Talks to the same database the server is using, so a summary can be seeded
  // without paying Gemini for one.
  const { writeSummary, logGeminiCall, pool } = await import('../src/db.js');

  // Reads an SSE response into a list of {event, data}.
  const stream = async (user, videoId, durationSeconds) => {
    const res = await fetch(`${BASE}/v1/videos/${videoId}/summary`, {
      method: 'POST',
      headers: { 'X-Yts-User': user, 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds }),
    });
    const events = [];
    for (const block of (await res.text()).split('\n\n')) {
      const e = block.match(/^event: (.+)$/m);
      const d = block.match(/^data: (.+)$/m);
      if (e && d) events.push({ event: e[1], data: JSON.parse(d[1]) });
    }
    return { status: res.status, contentType: res.headers.get('content-type'), events, res };
  };

  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();
  const video = newVideoId();

  let r = await stream(alice, video, 600);
  ok('responds as an event stream', r.contentType?.includes('text/event-stream'));
  ok('refuses over the length cap', (await stream(alice, newVideoId(), 99999)).events.at(-1)
    .data.code === 'TOO_LONG');

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
  const capUser = crypto.randomUUID();
  await logGeminiCall({
    videoId: newVideoId(),
    userId: capUser,
    durationSeconds: 60,
    cost: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalUsd: 999 },
  });
  try {
    r = await stream(crypto.randomUUID(), newVideoId(), 600);
    ok('a new generation is refused once the cap is hit', r.events.at(-1).data.code === 'SPEND_CAP',
      JSON.stringify(r.events.at(-1).data));

    // Crucially, already-generated summaries keep working - the cap stops new
    // spending, it does not take the service down.
    r = await stream(crypto.randomUUID(), video, 600);
    ok('existing summaries still serve under the cap', r.events.at(-1).data.ok === true);
  } finally {
    await pool.query('DELETE FROM gemini_calls WHERE user_id = $1', [capUser]);
  }

  r = await stream(crypto.randomUUID(), newVideoId(), 600);
  ok('once under the cap again, it reaches the key check', r.events.at(-1).data.code === 'NO_API_KEY');

  await pool.end();
}

// ------------------------------------------------------------------ rejects

section('input validation');
{
  const user = crypto.randomUUID();
  let res = await fetch(`${BASE}/v1/me/quota`);
  ok('a missing user header is rejected', res.status === 401);

  res = await fetch(`${BASE}/v1/me/quota`, { headers: { 'X-Yts-User': 'not-a-uuid' } });
  ok('a malformed user header is rejected', res.status === 401);

  res = await fetch(`${BASE}/v1/videos/short`, { headers: { 'X-Yts-User': user } });
  ok('a malformed videoId is rejected', res.status === 400);

  res = await fetch(`${BASE}/v1/health`);
  ok('health needs no auth', res.status === 200);
}

console.log(`\n${failures === 0 ? 'all tests passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
