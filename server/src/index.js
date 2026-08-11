import { createServer } from 'node:http';

import { config, validateConfig } from './config.js';
import {
  readStats,
  readQuota,
  commitView,
  castVote,
  hasViewed,
  listViewedVideos,
  deleteUserData,
  hitRateLimit,
  pruneRateLimits,
  migrate,
} from './db.js';
import { summarise, SummariseError, resolveDurationOrRefuse } from './summarise.js';
import { maybeSendDailyDigest, maybeSendSpendAlert } from './digest.js';
import {
  signInWithGoogle,
  signOut,
  resolveSession,
  hashUserId,
  pruneSessions,
  AuthError,
} from './auth.js';

// No framework: five routes, a JSON body and a CORS header. Every dependency
// this service does not have is one it cannot be compromised through.

const MAX_BODY_BYTES = 4096;

// YouTube ids are exactly 11 url-safe characters. Anything else is either a
// bug in the client or someone poking at the endpoint.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// ---------- identity ----------
//
// A bearer session token, issued only after a Google sign-in this server
// verified itself. It replaces the client-minted UUID that came before, which
// anyone could rotate for a fresh allowance - fine while each user paid for
// their own Gemini calls, not fine now that the server pays.
async function identify(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return resolveSession(token);
}

// ---------- housekeeping ----------
//
// Rate limiting now lives in Postgres (see hitRateLimit) so it holds across a
// restart and across instances. What is left here is the sweeping.
setInterval(() => {
  pruneRateLimits().catch((err) => console.warn('[yts:api] rate-limit prune:', err.message));
  pruneSessions().catch((err) => console.warn('[yts:api] session prune:', err.message));
  // Both are cheap no-ops most of the time: the digest only ever does
  // something once a day, and the alert only on a threshold crossing. Riding
  // the same five-minute tick as the rest of the housekeeping is one fewer
  // timer to reason about.
  maybeSendDailyDigest().catch((err) => console.warn('[yts:api] daily digest:', err.message));
  maybeSendSpendAlert().catch((err) => console.warn('[yts:api] spend alert:', err.message));
}, 300000).unref();

// ---------- plumbing ----------

const CORS_METHODS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function corsHeaders(origin) {
  // No Origin header at all means this is not a browser cross-origin request:
  // curl, a platform health check, or an extension service worker that Chrome
  // exempted because host_permissions already grant access. CORS has nothing
  // to say about those, and rejecting them would lock out the extension the
  // allowlist exists to serve.
  if (!origin) return { 'Access-Control-Allow-Origin': '*', ...CORS_METHODS };

  const allowed = config.allowedOrigins.includes('*')
    ? '*'
    : config.allowedOrigins.includes(origin)
      ? origin
      : null;
  if (!allowed) return null;
  return { 'Access-Control-Allow-Origin': allowed, ...CORS_METHODS };
}

function send(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

// ---------- server-sent events ----------
//
// The summarise endpoint streams because a generation takes tens of seconds and
// watching text arrive is the difference between "working" and "hung". Anything
// already generated is sent as a single done event - there is nothing to wait
// for, so pretending to stream it would only add latency.
function openStream(res, cors) {
  res.writeHead(200, {
    ...cors,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Without this, nginx and most platform proxies buffer the whole response
    // and the stream arrives all at once at the end.
    'X-Accel-Buffering': 'no',
  });
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

async function handleSummariseStream(req, res, cors, auth, videoId, durationSeconds) {
  const send = openStream(res, cors);

  // If the client goes away mid-generation we still finish and store the
  // summary: it has been paid for either way, and the next reader gets it free.
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });

  try {
    const result = await summarise({
      videoId,
      auth,
      durationSeconds,
      onDelta: (markdown) => {
        if (!clientGone) send('delta', { markdown });
      },
    });
    send('done', {
      ok: true,
      markdown: result.markdown,
      model: result.model,
      generated: result.generated,
      stats: result.stats,
      quota: result.quota,
    });
  } catch (err) {
    if (err instanceof SummariseError) {
      send('failed', { ok: false, code: err.code, error: err.message, ...err.extra });
    } else {
      console.error('[yts:api] summarise failed for %s:', videoId, err);
      send('failed', { ok: false, code: 'INTERNAL', error: 'Could not summarise that video.' });
    }
  } finally {
    res.end();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- routes ----------

async function route(req, url, auth) {
  const parts = url.pathname.split('/').filter(Boolean);
  const { userId } = auth;

  // GET /v1/me
  if (req.method === 'GET' && url.pathname === '/v1/me') {
    return {
      status: 200,
      body: {
        ok: true,
        user: { email: auth.email, plan: auth.plan },
        quota: await readQuota(userId, auth),
      },
    };
  }

  // GET /v1/me/quota
  if (req.method === 'GET' && url.pathname === '/v1/me/quota') {
    return { status: 200, body: { ok: true, quota: await readQuota(userId, auth) } };
  }

  // GET /v1/me/videos
  // Every video this user has paid for, which is what decides whether a card
  // in the feed says "Summarise" or "Summarised". Sent as a whole list rather
  // than queried per card: it is a few thousand 11-character strings at worst,
  // and the alternative is a request every time the feed scrolls.
  if (req.method === 'GET' && url.pathname === '/v1/me/videos') {
    return { status: 200, body: { ok: true, videoIds: await listViewedVideos(userId) } };
  }

  // DELETE /v1/me
  // The GDPR erasure route, and the one people skip. Wired to a button in the
  // extension's settings so it is actually reachable, not just documented.
  if (req.method === 'DELETE' && url.pathname === '/v1/me') {
    // The hash is what lets erasure stay honest without handing back a fresh
    // allowance - see deleteUserData.
    const result = await deleteUserData(userId, await hashUserId(userId));
    console.log('[yts:api] erased data for %s (%d views)', userId, result.viewsDeleted);
    return { status: 200, body: { ok: true, ...result } };
  }

  // /v1/videos/:videoId[/view|/vote]
  if (parts[0] === 'v1' && parts[1] === 'videos' && parts[2]) {
    const videoId = parts[2];
    if (!VIDEO_ID_RE.test(videoId)) {
      return { status: 400, body: { ok: false, error: 'malformed videoId' } };
    }

    // Quota rides along with the stats because the client wants both at the
    // same instant - it is deciding whether to spend a summarise on this video.
    if (req.method === 'GET' && parts.length === 3) {
      const [stats, quota] = await Promise.all([
        readStats(videoId, userId),
        readQuota(userId, auth),
      ]);
      return { status: 200, body: { ok: true, stats, quota } };
    }

    if (req.method === 'POST' && parts[3] === 'view' && parts.length === 4) {
      const body = await readBody(req);

      // This route bills the caller's allowance, so it resolves the length the
      // same way the summarise path does. It is not the lesser hole of the two:
      // a view recorded for one second makes the video "already paid for", and
      // the summarise path then skips the quota check entirely for it.
      let durationSeconds;
      try {
        durationSeconds = await resolveDurationOrRefuse(videoId, Number(body.durationSeconds) || 0);
      } catch (err) {
        if (err instanceof SummariseError) {
          return { status: 503, body: { ok: false, code: err.code, error: err.message } };
        }
        throw err;
      }
      if (!durationSeconds) {
        return {
          status: 400,
          body: {
            ok: false,
            code: 'UNKNOWN_DURATION',
            error: 'Could not work out how long that video is.',
          },
        };
      }

      // Checked here rather than trusting the client's pre-flight check: the
      // pre-check exists to give a good error message, this is the rule.
      // A video this user has already been billed for is free to open again,
      // so it must not be refused when they are out of quota - commitView
      // would not have charged for it either.
      const [quota, repeat] = await Promise.all([
        readQuota(userId, auth),
        hasViewed(videoId, userId),
      ]);
      if (!repeat && quota.remainingSeconds < durationSeconds) {
        return {
          status: 429,
          body: {
            ok: false,
            code: 'QUOTA_EXCEEDED',
            quota,
            stats: await readStats(videoId, userId),
          },
        };
      }

      await commitView(videoId, userId, durationSeconds);
      const [stats, fresh] = await Promise.all([
        readStats(videoId, userId),
        readQuota(userId, auth),
      ]);
      return { status: 200, body: { ok: true, stats, quota: fresh } };
    }

    if (req.method === 'POST' && parts[3] === 'vote' && parts.length === 4) {
      const body = await readBody(req);
      const vote = body.vote === 'up' || body.vote === 'down' ? body.vote : null;
      const { revision, retired, exhausted } = await castVote(videoId, userId, vote);
      return {
        status: 200,
        body: {
          ok: true,
          // `retired` means this vote is what tipped the summary over the
          // threshold. `revision` is the new one - a client holding anything
          // older re-summarises on next open, which is what makes the re-run
          // automatic rather than a button someone has to press.
          // `exhausted` means it was rejected but has already had its one
          // rewrite, so nothing more happens.
          revision,
          retired,
          exhausted,
          stats: await readStats(videoId, userId),
        },
      };
    }
  }

  return { status: 404, body: { ok: false, error: 'not found' } };
}

// ---------- server ----------

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const cors = corsHeaders(origin);

  if (!cors) {
    send(res, 403, { ok: false, error: 'origin not allowed' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    send(res, 400, { ok: false, error: 'bad request' }, cors);
    return;
  }

  if (url.pathname === '/v1/health') {
    send(res, 200, { ok: true }, cors);
    return;
  }

  // Signing in is the one thing you cannot already be signed in for.
  if (req.method === 'POST' && url.pathname === '/v1/auth/google') {
    try {
      const body = await readBody(req);
      const result = await signInWithGoogle(body);
      console.log('[yts:api] signed in %s (%s)', result.user.user_id, result.user.plan);
      send(res, 200, { ok: true, ...result }, cors);
    } catch (err) {
      const known = err instanceof AuthError;
      if (!known) console.error('[yts:api] sign-in failed:', err);
      send(
        res,
        known ? 400 : 500,
        { ok: false, code: known ? err.code : 'INTERNAL', error: err.message },
        cors
      );
    }
    return;
  }

  const auth = await identify(req);
  if (!auth) {
    // Read under a "Sign in to summarise — it's free" heading in the panel, so
    // this is the supporting sentence rather than another instruction.
    send(
      res,
      401,
      {
        ok: false,
        code: 'SIGN_IN_REQUIRED',
        error: 'Signing in with Google takes a second and lets you summarise any video.',
      },
      cors
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
    await signOut((req.headers.authorization || '').slice(7).trim());
    send(res, 200, { ok: true }, cors);
    return;
  }

  if (await hitRateLimit(auth.userId, config.rateLimitPerMinute)) {
    send(res, 429, { ok: false, code: 'RATE_LIMITED', error: 'too many requests' }, cors);
    return;
  }

  try {
    // Handled outside route() because it writes to the socket over time rather
    // than returning one body.
    const summariseMatch = url.pathname.match(/^\/v1\/videos\/([A-Za-z0-9_-]{11})\/summary$/);
    if (summariseMatch && req.method === 'POST') {
      const body = await readBody(req);
      await handleSummariseStream(
        req,
        res,
        cors,
        auth,
        summariseMatch[1],
        Number(body.durationSeconds) || 0
      );
      return;
    }

    const { status, body } = await route(req, url, auth);
    send(res, status, body, cors);
  } catch (err) {
    console.error('[yts:api] %s %s failed:', req.method, url.pathname, err.message);
    send(res, 400, { ok: false, error: err.message }, cors);
  }
});

// Configuration before anything else, so a bad variable is the first thing in
// the log rather than a driver error several minutes later.
validateConfig();

// Schema before listener: a request that arrives against a half-created schema
// fails in a far more confusing way than a few seconds of startup delay.
try {
  await migrate();
} catch (err) {
  console.error('\n[yts:api] cannot start - the database is unreachable:\n');
  console.error('  · %s\n', err.message);
  console.error(
    '  Check DATABASE_URL, and that YTS_DATABASE_SSL=true if your provider requires TLS.\n'
  );
  process.exit(1);
}

// Run once at boot rather than waiting up to five minutes for the first tick -
// a restart during an incident should not delay the cap alert that matters
// most right then.
maybeSendDailyDigest().catch((err) => console.warn('[yts:api] daily digest:', err.message));
maybeSendSpendAlert().catch((err) => console.warn('[yts:api] spend alert:', err.message));

server.listen(config.port, () => {
  console.log(
    '[yts:api] listening on http://localhost:%d · quota %d min/week · re-run at %d downvotes and %d%% down (max rev %d)',
    config.port,
    config.weeklyQuotaSeconds / 60,
    config.downvoteMinimum,
    Math.round(config.downvoteRatio * 100),
    config.maxRevision
  );
});
