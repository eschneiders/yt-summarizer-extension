import { config } from './config.js';
import { readVideoDuration, writeVideoDuration } from './db.js';

// How long a video actually is, decided here rather than taken from whoever is
// asking. The client scrapes a duration off the card and sends it, and while
// the only client is ours that is accurate; a hand-written one can claim a
// three-hour video is sixty seconds and get it summarised for a minute of
// allowance. Everything metered - the weekly quota, the length cap - is metered
// against this number, so this is where it stops being the caller's to choose.
//
// YouTube Data API v3, `videos.list?part=contentDetails`: 1 unit of a
// 10,000/day free quota per call. The answer is written onto the videos row, so
// a video is looked up once ever and every later reader is a database read.
// A busy day is a few hundred new videos against a ten-thousand budget.

const ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

// A lookup that failed for a reason that might not be true in a minute: the
// network, a 5xx, an exhausted daily quota. Distinct from "YouTube says there
// is no such video", which is an answer and not a failure.
export class DurationUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'DurationUnavailable';
  }
}

// ISO-8601 durations, which is what contentDetails.duration is: PT12M34S,
// PT1H2M, P1DT4H. Returns seconds, or 0 for anything unparseable or empty.
// A live stream in progress reports P0D and so lands on 0, which is right - it
// has no length yet and must not be summarised as though it did.
export function parseIso8601Duration(text) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    String(text || '').trim()
  );
  if (!m) return 0;
  const [, w, d, h, min, s] = m;
  const seconds =
    Number(w || 0) * 604800 +
    Number(d || 0) * 86400 +
    Number(h || 0) * 3600 +
    Number(min || 0) * 60 +
    Number(s || 0);
  return Math.round(seconds);
}

// One call to YouTube. Returns seconds, or 0 if YouTube has no such video -
// deleted, private, or an id someone made up. Throws DurationUnavailable if the
// question could not be asked rather than answered.
async function lookup(videoId) {
  const url =
    `${ENDPOINT}?part=contentDetails&id=${encodeURIComponent(videoId)}` +
    `&key=${encodeURIComponent(config.youtubeApiKey)}`;

  let res;
  try {
    // A summarise request is already waiting on this, and the alternative to a
    // timeout is a socket that hangs until the client gives up.
    res = await fetch(url, { signal: AbortSignal.timeout(config.youtubeTimeoutMs) });
  } catch (err) {
    throw new DurationUnavailable(`could not reach the YouTube API: ${err.message}`);
  }

  if (!res.ok) {
    // 403 here is usually the daily quota, or a key that is not allowed to call
    // this API. Both are transient in the sense that matters: refusing is right,
    // trusting the caller instead is not.
    const detail = await res.text().catch(() => '');
    throw new DurationUnavailable(
      `YouTube API returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    );
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw new DurationUnavailable(`YouTube API sent something that is not JSON: ${err.message}`);
  }

  const item = Array.isArray(payload.items) ? payload.items[0] : null;
  if (!item) return 0;
  return parseIso8601Duration(item.contentDetails && item.contentDetails.duration);
}

/**
 * The authoritative length of a video, in seconds.
 *
 * Returns 0 when the length is genuinely unknown - no such video, or a live
 * stream with no length yet - which callers must treat as a refusal, because
 * something that cannot be metered must not be served.
 *
 * `claimedSeconds` is only ever used when no YOUTUBE_API_KEY is configured, so
 * an existing deploy and a local checkout keep working exactly as they did.
 * That is the old, trusting behaviour, and validateConfig says so at startup.
 *
 * @throws {DurationUnavailable} when the lookup could not be completed.
 */
export async function resolveDuration(videoId, claimedSeconds = 0) {
  // Looked up once ever. The cache is the reason a 10,000/day quota is roomy:
  // it is one call per video that has never been seen, not one per request.
  const cached = await readVideoDuration(videoId);
  if (cached > 0) return cached;

  if (!config.youtubeApiKey) {
    return Math.max(0, Math.round(Number(claimedSeconds) || 0));
  }

  const seconds = await lookup(videoId);
  // Only a real length is cached. A zero would otherwise pin a video that was
  // briefly unavailable - or was live when first asked about - as permanently
  // unsummarisable.
  if (seconds > 0) await writeVideoDuration(videoId, seconds);
  return seconds;
}
