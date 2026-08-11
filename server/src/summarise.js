import { config } from './config.js';
import { summarizeYouTubeVideoStreaming, summarizeYouTubeVideo, MODEL } from './gemini.js';
import { resolveDuration, DurationUnavailable } from './youtube.js';
import { reportCritical, CRITICAL } from './digest.js';
import {
  readStats,
  readQuota,
  commitView,
  hasViewed,
  readSummary,
  writeSummary,
  logGeminiCall,
  spendSince,
} from './db.js';

// The only path in this service that spends money, so every guard lives here
// and they are ordered cheapest-first: reject on quota before touching the
// spend table, and on both before calling Gemini.
//
// The one thing ahead of all of them is working out how long the video is,
// because every guard below is measured in seconds of video and none of them
// mean anything if that number came from whoever is asking. See youtube.js.

const DAY_MS = 86400000;

// In-process, which is correct for what it defends: one user hammering one
// instance. It is NOT the quota - that is in Postgres and survives restarts and
// multiple instances. This only stops a single client from having several paid
// calls in flight at once.
const inFlight = new Map();

function acquireSlot(userId) {
  const current = inFlight.get(userId) || 0;
  if (current >= config.maxConcurrentPerUser) return false;
  inFlight.set(userId, current + 1);
  return true;
}

function releaseSlot(userId) {
  const current = (inFlight.get(userId) || 1) - 1;
  if (current <= 0) inFlight.delete(userId);
  else inFlight.set(userId, current);
}

export class SummariseError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// The authoritative length of a video, or a refusal. Fails closed: if YouTube
// cannot be asked, nothing is generated, rather than falling back to a number
// the caller chose. An outage costs new videos only - anything already
// summarised has its length on the videos row and needs no lookup - so the
// blast radius of failing closed is exactly the path that spends money.
export async function resolveDurationOrRefuse(videoId, claimedSeconds) {
  try {
    return await resolveDuration(videoId, claimedSeconds);
  } catch (err) {
    if (err instanceof DurationUnavailable) {
      console.error('[yts:api] duration lookup failed for %s: %s', videoId, err.message);
      // Nobody can summarise a video nobody has done before while this is
      // broken, which is the service half-down rather than one bad request.
      reportCritical(CRITICAL.YOUTUBE, `${videoId}: ${err.message}`);
      throw new SummariseError(
        'DURATION_LOOKUP_FAILED',
        'Could not check how long that video is just now. Please try again shortly.'
      );
    }
    throw err;
  }
}

// Resolves what should happen for this (user, video) without spending anything:
// whether a summary already exists, whether this user has to be billed, and
// whether they can afford it. Separated out so the SSE handler can report a
// refusal before opening a stream.
export async function planSummary(videoId, auth, claimedSeconds) {
  const { userId } = auth;

  // How long the video is, asked of YouTube rather than of the caller. The
  // number the client sends is a hint for its own button label; from here on
  // everything that meters - the allowance, the length cap - uses this one.
  const durationSeconds = await resolveDurationOrRefuse(videoId, claimedSeconds);

  // A duration of zero used to sail straight through: it is under the length
  // cap, it costs nothing against the weekly allowance, and commitView only
  // bills when seconds > 0. So an unknown duration meant a free, uncapped
  // summary of a video of any length. Refuse instead - a request that cannot
  // be metered must not be served.
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new SummariseError(
      'UNKNOWN_DURATION',
      'Could not work out how long that video is, so it cannot be summarised.'
    );
  }

  if (durationSeconds > config.maxVideoSeconds) {
    throw new SummariseError(
      'TOO_LONG',
      `That video is longer than the ${Math.round(config.maxVideoSeconds / 60)} minute limit.`
    );
  }

  const [stats, quota, alreadyPaid] = await Promise.all([
    readStats(videoId, userId),
    readQuota(userId, auth),
    hasViewed(videoId, userId),
  ]);

  // A video this user has already been billed for is free to re-open, whether
  // or not anyone has to generate anything.
  const needsBilling = !alreadyPaid;
  if (needsBilling && quota.remainingSeconds < durationSeconds) {
    throw new SummariseError(
      'QUOTA_EXCEEDED',
      `This video needs ${Math.round(durationSeconds / 60)} minutes and you have ` +
        `${Math.round(quota.remainingSeconds / 60)} left this week.`,
      { quota }
    );
  }

  const existing = await readSummary(videoId, stats.revision);
  return { stats, quota, needsBilling, existing, durationSeconds };
}

// Refuses if today's spend has already reached the cap. Deliberately checked
// immediately before the call rather than cached: the whole point is that it
// holds when something has gone wrong and calls are arriving in a flood.
async function assertUnderSpendCap() {
  const spent = await spendSince(Date.now() - DAY_MS);
  if (spent >= config.dailySpendCapUsd) {
    console.error(
      '[yts:api] SPEND CAP HIT: $%s in the last 24h against a $%s cap - refusing new generations',
      spent.toFixed(4),
      config.dailySpendCapUsd.toFixed(2)
    );
    throw new SummariseError(
      'SPEND_CAP',
      'The service has hit its daily limit. Please try again tomorrow.'
    );
  }
  return spent;
}

/**
 * Produces a summary for a video, generating it only if nobody has yet.
 *
 * onDelta receives the full markdown-so-far as it streams. It is only called
 * for a genuine generation - a summary that already exists arrives whole,
 * because there is nothing to wait for.
 */
export async function summarise({ videoId, auth, durationSeconds: claimedSeconds, onDelta }) {
  const { userId } = auth;
  const intent = await planSummary(videoId, auth, claimedSeconds);
  // What the client asked with is a hint. What gets billed, capped and sent to
  // Gemini is what planSummary resolved.
  const { durationSeconds } = intent;

  // Someone has already paid to generate this. Serving it costs nothing, but
  // reading it still comes out of the reader's weekly allowance unless it is
  // already theirs.
  if (intent.existing) {
    if (intent.needsBilling) await commitView(videoId, userId, durationSeconds);
    const stats = await readStats(videoId, userId);
    return {
      markdown: intent.existing.markdown,
      model: intent.existing.model,
      generated: false,
      stats,
      quota: await readQuota(userId, auth),
    };
  }

  // Past this point the request would cost money, so the spend cap goes first -
  // ahead of even the "is this service configured" check. It is the gate that
  // must be hardest to accidentally step around, so it sits outermost.
  await assertUnderSpendCap();

  if (!config.geminiApiKey) {
    throw new SummariseError('NO_API_KEY', 'The service is not configured with a Gemini key.');
  }

  if (!acquireSlot(userId)) {
    // The client retries this rather than showing it, so it reads as patience
    // rather than a refusal on the rare occasion it does surface.
    throw new SummariseError(
      'TOO_MANY_REQUESTS',
      'Still finishing your other summaries — this one is queued.'
    );
  }

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let result;
    try {
      result = await summarizeYouTubeVideoStreaming({
        apiKey: config.geminiApiKey,
        videoUrl,
        durationSeconds,
        onDelta,
      });
    } catch (streamErr) {
      // The SSE event payloads for this endpoint are not documented with
      // concrete examples, so if streaming fails for any reason, fall back
      // rather than losing a summary that has already been paid for.
      console.warn(
        '[yts:api] streaming failed (%s), falling back to blocking call',
        streamErr.message
      );
      try {
        result = await summarizeYouTubeVideo({
          apiKey: config.geminiApiKey,
          videoUrl,
          durationSeconds,
        });
      } catch (blockingErr) {
        // Both paths failed, so this is not a flaky stream - no summary can be
        // generated at all right now.
        reportCritical(
          CRITICAL.GEMINI,
          `${videoId}: streaming "${streamErr.message}", blocking "${blockingErr.message}"`
        );
        throw blockingErr;
      }
    }

    // Record the spend before anything that could fail. An unlogged paid call
    // is invisible to the cap, and the cap is the thing standing between a bug
    // and a bill.
    await logGeminiCall({ videoId, userId, durationSeconds, cost: result.cost });

    await writeSummary(videoId, intent.stats.revision, result.markdown, result.model);
    if (intent.needsBilling) await commitView(videoId, userId, durationSeconds);

    const [stats, quota] = await Promise.all([
      readStats(videoId, userId),
      readQuota(userId, auth),
    ]);
    return {
      markdown: result.markdown,
      model: result.model || MODEL,
      generated: true,
      cost: result.cost,
      stats,
      quota,
    };
  } finally {
    releaseSlot(userId);
  }
}
