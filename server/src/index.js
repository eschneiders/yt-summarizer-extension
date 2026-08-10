import { createServer } from 'node:http';

import { config } from './config.js';
import { readStats, readQuota, commitView, castVote, hasViewed } from './db.js';

// No framework: five routes, a JSON body and a CORS header. Every dependency
// this service does not have is one it cannot be compromised through.

const MAX_BODY_BYTES = 4096;

// YouTube ids are exactly 11 url-safe characters. Anything else is either a
// bug in the client or someone poking at the endpoint.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- identity ----------
//
// The client mints a UUID on install and sends it on every request. That is
// enough to give each browser its own quota and its own vote, and it holds no
// personal data. It is also trivially forgeable: anyone can rotate the header
// and get a fresh 300 minutes. That is acceptable while summarising happens on
// the client's own API key - the moment the *server* starts paying for Gemini
// calls, this has to become real authentication.
function identify(req) {
  const id = req.headers['x-yts-user'];
  return typeof id === 'string' && USER_ID_RE.test(id) ? id.toLowerCase() : null;
}

// ---------- rate limiting ----------
//
// Fixed window per user id, in memory. Resets when the process restarts, which
// is fine for what it defends against: a runaway client loop, not an attacker.
const hits = new Map();

function rateLimited(userId) {
  const minute = Math.floor(Date.now() / 60000);
  const entry = hits.get(userId);
  if (!entry || entry.minute !== minute) {
    hits.set(userId, { minute, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > config.rateLimitPerMinute;
}

// Unbounded growth would be a slow leak on a long-running process.
setInterval(() => {
  const minute = Math.floor(Date.now() / 60000);
  for (const [key, entry] of hits) if (entry.minute < minute) hits.delete(key);
}, 60000).unref();

// ---------- plumbing ----------

function corsHeaders(origin) {
  const allowed = config.allowedOrigins.includes('*')
    ? '*'
    : config.allowedOrigins.includes(origin)
      ? origin
      : null;
  if (!allowed) return null;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Yts-User',
    'Access-Control-Max-Age': '86400',
  };
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

async function route(req, url, userId) {
  const parts = url.pathname.split('/').filter(Boolean);

  // GET /v1/me/quota
  if (req.method === 'GET' && url.pathname === '/v1/me/quota') {
    return { status: 200, body: { ok: true, quota: readQuota(userId) } };
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
      return {
        status: 200,
        body: { ok: true, stats: readStats(videoId, userId), quota: readQuota(userId) },
      };
    }

    if (req.method === 'POST' && parts[3] === 'view' && parts.length === 4) {
      const body = await readBody(req);
      const durationSeconds = Number(body.durationSeconds) || 0;

      // Checked here rather than trusting the client's pre-flight check: the
      // pre-check exists to give a good error message, this is the rule.
      // A video this user has already been billed for is free to open again,
      // so it must not be refused when they are out of quota - commitView
      // would not have charged for it either.
      const quota = readQuota(userId);
      const repeat = hasViewed(videoId, userId);
      if (!repeat && quota.remainingSeconds < durationSeconds) {
        return {
          status: 429,
          body: { ok: false, code: 'QUOTA_EXCEEDED', quota, stats: readStats(videoId, userId) },
        };
      }

      commitView(videoId, userId, durationSeconds);
      return {
        status: 200,
        body: { ok: true, stats: readStats(videoId, userId), quota: readQuota(userId) },
      };
    }

    if (req.method === 'POST' && parts[3] === 'vote' && parts.length === 4) {
      const body = await readBody(req);
      const vote = body.vote === 'up' || body.vote === 'down' ? body.vote : null;
      const { revision, retired, exhausted } = castVote(videoId, userId, vote);
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
          stats: readStats(videoId, userId),
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

  const userId = identify(req);
  if (!userId) {
    send(res, 401, { ok: false, error: 'X-Yts-User must be a UUID' }, cors);
    return;
  }

  if (rateLimited(userId)) {
    send(res, 429, { ok: false, code: 'RATE_LIMITED', error: 'too many requests' }, cors);
    return;
  }

  try {
    const { status, body } = await route(req, url, userId);
    send(res, status, body, cors);
  } catch (err) {
    console.error('[yts:api] %s %s failed:', req.method, url.pathname, err.message);
    send(res, 400, { ok: false, error: err.message }, cors);
  }
});

server.listen(config.port, () => {
  console.log(
    '[yts:api] listening on http://localhost:%d · quota %d min/week · re-run at %d downvotes and %d%% down',
    config.port,
    config.weeklyQuotaSeconds / 60,
    config.downvoteMinimum,
    Math.round(config.downvoteRatio * 100)
  );
});
