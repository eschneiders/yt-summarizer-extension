// Client for the summariser service (see server/). Everything here degrades to
// null rather than throwing: with no service URL saved, or the service down,
// the extension keeps working exactly as it did before there was one - local
// cache, local votes, no counter. A stats endpoint is never worth breaking a
// summary over.

const TIMEOUT_MS = 4000;

// A cached summary opens instantly, and it still asks the service for the
// counter and the retirement check on the way. If the service is down, that
// turns every instant open into a 4-second wait. So after one failure, stop
// calling for a while and let the extension be local-only in the meantime.
const COOL_DOWN_MS = 30000;
let coolDownUntil = 0;

// Anonymous and per-profile. Minted once on first use, holds no personal data,
// and is the only thing tying a quota and a vote to "a user". Deliberately not
// an account: see the note on identify() in server/src/index.js for why this
// has to change before the server pays for anything.
export async function ensureUserId() {
  const { ytsUserId } = await chrome.storage.local.get(['ytsUserId']);
  if (ytsUserId) return ytsUserId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ ytsUserId: fresh });
  console.log('[yts:sw] minted anonymous user id', fresh);
  return fresh;
}

async function baseUrl() {
  const { serviceUrl } = await chrome.storage.local.get(['serviceUrl']);
  return (serviceUrl || '').trim().replace(/\/+$/, '');
}

export async function isConfigured() {
  return !!(await baseUrl());
}

async function call(path, method, body) {
  const base = await baseUrl();
  if (!base) return null; // local-only mode
  if (Date.now() < coolDownUntil) return null; // service known down, don't wait on it

  const userId = await ensureUserId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(base + path, {
      method,
      headers: {
        'X-Yts-User': userId,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    coolDownUntil = 0;
    return { status: res.status, ...json };
  } catch (err) {
    // Timeout, DNS, connection refused, CORS - all the same to a caller that
    // is going to carry on without stats either way.
    coolDownUntil = Date.now() + COOL_DOWN_MS;
    console.warn(
      '[yts:sw] service unreachable (%s), local-only for the next %ds',
      err.message,
      COOL_DOWN_MS / 1000
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  // Stats + this user's quota in one trip: the caller is about to decide
  // whether summarising this video is free, billable, or over the limit.
  read: (videoId) => call(`/v1/videos/${videoId}`, 'GET'),
  view: (videoId, durationSeconds) =>
    call(`/v1/videos/${videoId}/view`, 'POST', { durationSeconds }),
  vote: (videoId, vote) => call(`/v1/videos/${videoId}/vote`, 'POST', { vote }),
  quota: () => call('/v1/me/quota', 'GET'),
};
