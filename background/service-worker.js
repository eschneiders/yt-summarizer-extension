import { summarizeYouTubeVideo, summarizeYouTubeVideoStreaming, MODEL } from './gemini.js';
import { api } from './api.js';

// Running total for this service-worker lifetime. MV3 can evict the worker
// when idle, which resets this - it is a convenience counter, not accounting.
let sessionCostUsd = 0;
let sessionCalls = 0;

const MAX_DURATION_SECONDS = 60 * 60;

// Summaries are cached by videoId. A cached entry is only reused if it was
// produced by the same model and cache format, so switching models or changing
// the prompt shape does not serve stale output.
const CACHE_PREFIX = 'sum:';
const CACHE_VERSION = 2; // 2 = markdown payloads (1 held parsed JSON)
const CACHE_MAX_ENTRIES = 300;

async function cacheGet(videoId) {
  const key = CACHE_PREFIX + videoId;
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry) return null;
  if (entry.cacheVersion !== CACHE_VERSION || entry.model !== MODEL) {
    console.log('[yts:sw] cache entry for %s is stale (model/version changed), ignoring', videoId);
    return null;
  }
  return entry;
}

async function cacheSet(videoId, payload) {
  await chrome.storage.local.set({
    [CACHE_PREFIX + videoId]: { ...payload, cacheVersion: CACHE_VERSION, savedAt: Date.now() },
  });
  await pruneCache();
}

// storage.local is finite, so keep the newest N summaries and drop the rest.
async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length <= CACHE_MAX_ENTRIES) return;
  keys.sort((a, b) => (all[a].savedAt || 0) - (all[b].savedAt || 0));
  const drop = keys.slice(0, keys.length - CACHE_MAX_ENTRIES);
  // A vote is about a specific summary, so it goes when that summary goes.
  const votes = drop.map((k) => VOTE_PREFIX + k.slice(CACHE_PREFIX.length));
  await chrome.storage.local.remove(drop.concat(votes));
  console.log('[yts:sw] pruned %d old cached summaries', drop.length);
}

// Entries from an older model or cache format can never be served, so they are
// pure dead weight in a finite storage area. Cleared at startup rather than
// lazily, so the space comes back on the model change rather than whenever the
// video in question next happens to be opened.
async function sweepStaleEntries() {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter(
    (k) =>
      k.startsWith(CACHE_PREFIX) &&
      (all[k].cacheVersion !== CACHE_VERSION || all[k].model !== MODEL)
  );
  if (!stale.length) return;
  const votes = stale.map((k) => VOTE_PREFIX + k.slice(CACHE_PREFIX.length));
  await chrome.storage.local.remove(stale.concat(votes));
  console.log('[yts:sw] dropped %d summaries from an older model/format', stale.length);
}

// One summary per video is reused by everyone who opens it, so a reader who
// finds it wrong cannot simply pay to redo it - they vote instead. This stores
// only *this* user's vote. Turning enough thumbs-down into an automatic re-run
// is inherently a server-side decision: no client can see anyone else's votes.
// reportVote below is where that call goes once there is something to call.
const VOTE_PREFIX = 'vote:';

// Videos *this user* has been billed for, as opposed to videos this browser
// happens to hold a summary of. The two are not the same thing: a summary is
// written once and reused, so opening one someone else generated still costs
// the reader their minutes. The server's `youViewed` is the authority; this is
// the offline mirror of it, and what the "Summarised" label reads.
const MINE_PREFIX = 'mine:';

async function markMine(videoId) {
  await chrome.storage.local.set({ [MINE_PREFIX + videoId]: Date.now() });
}

async function isMine(videoId) {
  const key = MINE_PREFIX + videoId;
  const stored = await chrome.storage.local.get(key);
  return stored[key] !== undefined;
}

async function voteGet(videoId) {
  const key = VOTE_PREFIX + videoId;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ? stored[key].vote : null;
}

async function voteSet(videoId, vote) {
  const key = VOTE_PREFIX + videoId;
  if (!vote) {
    await chrome.storage.local.remove(key);
    return null;
  }
  await chrome.storage.local.set({ [key]: { vote, votedAt: Date.now() } });
  return vote;
}

// A summary the crowd has retired must not be served again from this cache -
// dropping it is what makes the next open re-summarise by itself.
async function cacheDrop(videoId) {
  await chrome.storage.local.remove(CACHE_PREFIX + videoId);
}

// Everything the panel needs to know about a video that this client cannot
// work out on its own. Null whenever the service is not configured or is down,
// and every caller treats that as "carry on without it".
async function readRemote(videoId) {
  const res = await api.read(videoId);
  if (!res || !res.ok) return null;
  return res;
}

// "12 minutes" rather than formatDuration's "12:30" - a weekly allowance reads
// as a quantity, not as a timestamp.
function formatMinutes(totalSeconds) {
  const minutes = Math.floor(Math.max(0, totalSeconds) / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

const HANDLERS = {
  // Summarise a video by handing Gemini the watch URL directly.
  async YTS_SUMMARIZE(message) {
    // Cache first: a repeat click costs nothing and returns instantly, which
    // is also the only real answer to "why is this slower than the Gemini app".
    if (!message.refresh) {
      const cached = await cacheGet(message.videoId);
      if (cached) {
        console.log('[yts:sw] cache HIT for %s (saved %s)', message.videoId, new Date(cached.savedAt).toLocaleString());
        return { ok: true, markdown: cached.markdown, model: cached.model, cached: true, cost: null };
      }
    }

    const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);

    if (!geminiApiKey) {
      return { ok: false, code: 'NO_API_KEY', error: 'No Gemini API key saved yet.' };
    }

    // Cost scales with video length, so a stray click on a three-hour podcast
    // is the expensive mistake worth blocking. Overridable per click, never
    // silently.
    const duration = message.durationSeconds || 0;
    if (duration > MAX_DURATION_SECONDS && !message.override) {
      return {
        ok: false,
        code: 'TOO_LONG',
        durationSeconds: duration,
        error: `This video is ${formatDuration(duration)}, over the ${
          MAX_DURATION_SECONDS / 60
        } minute limit.`,
      };
    }

    const videoUrl = `https://www.youtube.com/watch?v=${message.videoId}`;
    const result = await summarizeYouTubeVideo({
      apiKey: geminiApiKey,
      videoUrl,
      durationSeconds: duration,
    });

    await cacheSet(message.videoId, { markdown: result.markdown, model: result.model });

    if (result.cost) {
      sessionCostUsd += result.cost.totalUsd;
      sessionCalls += 1;
      console.log(
        '[yts:sw] session total: $%s over %d call(s)',
        sessionCostUsd.toFixed(5),
        sessionCalls
      );
    }

    return { ok: true, ...result, sessionCostUsd, sessionCalls };
  },

  // Every videoId this user has already been billed for. Drives the
  // "Summarised" label, so it deliberately does NOT report videos this browser
  // merely holds a cached summary of - those still cost the reader their
  // minutes, and a button must never promise a free open that the quota gate
  // then refuses. The content script asks on every soft navigation, so this
  // reads keys only, never any values.
  async YTS_MINE_IDS() {
    const keys = chrome.storage.local.getKeys
      ? await chrome.storage.local.getKeys()
      : Object.keys(await chrome.storage.local.get(null));
    const ids = keys
      .filter((k) => k.startsWith(MINE_PREFIX))
      .map((k) => k.slice(MINE_PREFIX.length));
    return { ok: true, ids };
  },

  async YTS_VOTE(message) {
    const vote = await voteSet(message.videoId, message.vote);
    const res = await api.vote(message.videoId, vote);

    // The server owns the threshold, so it decides when a summary is retired.
    // Dropping our copy here means the next open re-summarises rather than
    // handing the reader back the summary they just marked wrong.
    if (res && res.ok && res.retired) {
      console.log('[yts:sw] %s retired by downvotes, dropping cached summary', message.videoId);
      await cacheDrop(message.videoId);
      await voteSet(message.videoId, null);
    }

    console.log('[yts:sw] vote for %s is now %s', message.videoId, vote || 'none');
    return {
      ok: true,
      vote: res && res.ok ? res.stats.yourVote : vote,
      stats: res && res.ok ? res.stats : null,
      retired: !!(res && res.ok && res.retired),
      exhausted: !!(res && res.ok && res.exhausted),
    };
  },

  // Content scripts cannot call chrome.tabs, so tab opening is proxied here.
  // active:false is what makes "Later" queue a video without stealing focus.
  async YTS_OPEN_TAB(message) {
    await chrome.tabs.create({ url: message.url, active: message.active !== false });
    return { ok: true };
  },

  async YTS_OPEN_OPTIONS() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

// Streaming needs a long-lived channel: sendMessage only carries one reply,
// so deltas arrive over a Port instead.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'yts-stream') return;

  port.onMessage.addListener(async (msg) => {
    const post = (payload) => {
      try {
        port.postMessage(payload);
      } catch (e) {
        // The tab navigated away mid-stream; nothing to deliver to.
      }
    };

    try {
      // One round trip, before anything else, for the three things only the
      // server knows: how many other people have summarised this, whether the
      // crowd has retired the summary we are holding, and what is left of this
      // week. Null when there is no service configured or it is unreachable.
      const remote = await readRemote(msg.videoId);
      const stats = remote ? remote.stats : null;
      const duration = msg.durationSeconds || 0;

      // Has this *user* paid for this video before? Not "is it in the cache" -
      // a summary is written once and read by many, so someone opening one
      // they did not generate is reading minutes they have not been billed
      // for. The server knows; offline we fall back to the local mirror.
      const alreadyMine = stats ? stats.youViewed : await isMine(msg.videoId);

      // Shared by the cache-hit path and the fresh-summary path below.
      const quotaError = (quota) => ({
        type: 'error',
        code: 'QUOTA_EXCEEDED',
        quota,
        error: `This video needs ${formatMinutes(duration)} and you have ${formatMinutes(
          quota.remainingSeconds
        )} left this week. Your allowance resets ${new Date(quota.resetsAt).toLocaleDateString()}.`,
      });

      if (!msg.refresh) {
        const cached = await cacheGet(msg.videoId);
        // Enough readers marked this summary wrong that the server moved the
        // video to a new revision. Our copy describes the retired one, so it
        // gets dropped and re-run - this is the automatic half of the
        // thumbs-down loop, and why there is no Re-summarise button.
        const retired = !!(cached && stats && stats.revision > (cached.revision || 1));
        if (retired) {
          console.log(
            '[yts:sw] summary for %s was retired by downvotes (rev %d -> %d), re-running',
            msg.videoId,
            cached.revision || 1,
            stats.revision
          );
          await cacheDrop(msg.videoId);
        } else if (cached) {
          // A cached summary costs nothing to serve, but it is not free to
          // read unless you are the one who generated it. Bill first; if that
          // is refused, the summary is not handed over.
          let billedStats = stats;
          if (!alreadyMine) {
            const billed = await api.view(msg.videoId, duration);
            if (billed && !billed.ok && billed.code === 'QUOTA_EXCEEDED') {
              post(quotaError(billed.quota));
              return;
            }
            if (billed && billed.ok) billedStats = billed.stats;
            await markMine(msg.videoId);
          }

          console.log(
            '[yts:sw] cache HIT for %s (%s)',
            msg.videoId,
            alreadyMine ? 'already yours, free' : 'billed to your week'
          );
          post({
            type: 'done',
            result: {
              ok: true,
              markdown: cached.markdown,
              model: cached.model,
              cached: true,
              cost: null,
              yourVote: billedStats ? billedStats.yourVote : await voteGet(msg.videoId),
              stats: billedStats,
            },
          });
          return;
        }
      }

      const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
      if (!geminiApiKey) {
        post({ type: 'error', code: 'NO_API_KEY', error: 'No Gemini API key saved yet.' });
        return;
      }

      if (duration > MAX_DURATION_SECONDS && !msg.override) {
        post({
          type: 'error',
          code: 'TOO_LONG',
          error: `This video is ${formatDuration(duration)}, over the ${
            MAX_DURATION_SECONDS / 60
          } minute limit.`,
        });
        return;
      }

      // Refuse before spending the API call rather than after. The server
      // re-checks this on the way out - that is the authoritative gate, this
      // one exists so the user gets told why instead of being billed.
      if (remote && remote.quota && !alreadyMine && remote.quota.remainingSeconds < duration) {
        post(quotaError(remote.quota));
        return;
      }

      const videoUrl = `https://www.youtube.com/watch?v=${msg.videoId}`;
      let result;
      try {
        result = await summarizeYouTubeVideoStreaming({
          apiKey: geminiApiKey,
          videoUrl,
          durationSeconds: duration,
          onDelta: (text) => post({ type: 'delta', text }),
        });
      } catch (streamErr) {
        // The SSE event payloads for this endpoint are not documented with
        // concrete examples, so if streaming fails for any reason, fall back
        // rather than losing the summary entirely.
        console.warn('[yts:sw] streaming failed (%s), falling back to blocking call', streamErr.message);
        post({ type: 'fallback', reason: streamErr.message });
        result = await summarizeYouTubeVideo({
          apiKey: geminiApiKey,
          videoUrl,
          durationSeconds: duration,
        });
      }

      // Bill and count only once the summary actually exists - a failed call
      // must not eat into anyone's week. The response carries the updated
      // counter, so the panel shows this user included.
      const viewed = await api.view(msg.videoId, duration);
      const finalStats = viewed && viewed.ok ? viewed.stats : stats;
      await markMine(msg.videoId);

      await cacheSet(msg.videoId, {
        markdown: result.markdown,
        model: result.model,
        // What "retired by downvotes" is measured against on the next open.
        revision: finalStats ? finalStats.revision : 1,
      });

      if (result.cost) {
        sessionCostUsd += result.cost.totalUsd;
        sessionCalls += 1;
      }
      post({
        type: 'done',
        result: {
          ok: true,
          ...result,
          sessionCostUsd,
          sessionCalls,
          yourVote: null,
          stats: finalStats,
          quota: viewed && viewed.ok ? viewed.quota : remote && remote.quota,
        },
      });
    } catch (err) {
      console.error('[yts:sw] stream handler failed', err);
      post({ type: 'error', error: err.message });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && HANDLERS[message.type];
  if (!handler) return false;

  (async () => {
    try {
      sendResponse(await handler(message));
    } catch (err) {
      console.error('[yts:sw] %s failed', message.type, err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the channel open for the async sendResponse
});

sweepStaleEntries().catch((err) => console.warn('[yts:sw] stale sweep failed', err));

console.log('[yts:sw] service worker ready, model =', MODEL);
