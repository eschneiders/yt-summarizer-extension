// Client for the summariser service (see server/). Everything here degrades to
// null rather than throwing: with no service URL saved, or the service down,
// the extension keeps working exactly as it did before there was one - local
// cache, local votes, no counter. A stats endpoint is never worth breaking a
// summary over.

import { getSessionToken } from './auth.js';

const TIMEOUT_MS = 4000;

// A cached summary opens instantly, and it still asks the service for the
// counter and the retirement check on the way. If the service is down, that
// turns every instant open into a 4-second wait. So after one failure, stop
// calling for a while and let the extension be local-only in the meantime.
const COOL_DOWN_MS = 30000;
let coolDownUntil = 0;

// A signed-in request carries the session token from a Google sign-in. A
// signed-out one carries an id this extension minted for itself, which buys a
// handful of already-written summaries a day and cannot generate anything.
//
// That id is not an identity and is not defended as one - it can be cleared and
// re-minted in a second. It does not need to be, because the only thing behind
// it is text that already exists, and serving that costs nothing. Anything that
// spends money is behind the session token.
async function identityHeader() {
  const token = await getSessionToken();
  if (token) return { Authorization: `Bearer ${token}` };
  return { 'X-YTS-Anon': await anonId() };
}

// Minted once, then kept. Lives alongside the session token rather than in
// sync storage: it is per-browser by design, and a value that followed someone
// between machines would be a tracking identifier, which this is not.
async function anonId() {
  const { anonId: existing } = await chrome.storage.local.get(['anonId']);
  if (existing) return existing;

  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await chrome.storage.local.set({ anonId: fresh });
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

  const auth = await identityHeader();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(base + path, {
      method,
      headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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

/**
 * Asks the server for a summary and reads its SSE response.
 *
 * Unlike everything else here this does NOT degrade to null - without the
 * service there is no summary at all any more, so a failure is a real error
 * the user has to see. onDelta receives the markdown-so-far during a genuine
 * generation; a summary someone has already paid for arrives whole.
 */
export async function summariseStream(videoId, durationSeconds, onDelta) {
  const base = await baseUrl();
  if (!base) {
    return { ok: false, code: 'NO_SERVICE', error: 'No summariser service configured.' };
  }

  // No local short-circuit when signed out any more. Whether this video can be
  // opened anonymously is a question only the server can answer - it depends on
  // whether anyone has summarised it yet, which is deliberately not something
  // this extension is told in advance.
  const auth = await identityHeader();

  let res;
  try {
    res = await fetch(`${base}/v1/videos/${videoId}/summary`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds }),
    });
  } catch (err) {
    coolDownUntil = Date.now() + COOL_DOWN_MS;
    return { ok: false, code: 'OFFLINE', error: `Could not reach the service: ${err.message}` };
  }

  if (!res.ok && res.status !== 200) {
    const detail = await res.json().catch(() => ({}));
    return {
      ok: false,
      code: detail.code || `HTTP_${res.status}`,
      error: detail.error || `Service returned HTTP ${res.status}.`,
    };
  }
  if (!res.body) return { ok: false, code: 'NO_BODY', error: 'Service sent an empty response.' };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final = null;

  // SSE frames are separated by a blank line; a frame can straddle two chunks,
  // so hold the tail back until its terminator arrives.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      const event = (frame.match(/^event: (.+)$/m) || [])[1];
      const raw = (frame.match(/^data: (.+)$/m) || [])[1];
      if (!event || !raw) continue;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }

      if (event === 'delta') onDelta(data.markdown);
      else if (event === 'done' || event === 'failed') final = data;
    }
  }

  return final || { ok: false, code: 'TRUNCATED', error: 'The service closed mid-summary.' };
}

export const api = {
  // Stats + this user's quota in one trip: the caller is about to decide
  // whether summarising this video is free, billable, or over the limit.
  read: (videoId) => call(`/v1/videos/${videoId}`, 'GET'),
  view: (videoId, durationSeconds) =>
    call(`/v1/videos/${videoId}/view`, 'POST', { durationSeconds }),
  vote: (videoId, vote) => call(`/v1/videos/${videoId}/vote`, 'POST', { vote }),
  quota: () => call('/v1/me/quota', 'GET'),
  myVideos: () => call('/v1/me/videos', 'GET'),
  deleteMe: () => call('/v1/me', 'DELETE'),
};
