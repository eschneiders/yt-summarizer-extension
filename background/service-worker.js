import { api, summariseStream } from './api.js';

// This used to hold the Gemini key, a summary cache, a vote store and a list of
// which videos were "yours". All of it now lives on the server, because all of
// it was either money or a number that has to be the same for everyone. What is
// left is a router: content scripts cannot make cross-origin requests or open
// tabs, so those go through here.
//
// Nothing is cached locally on purpose. A summary is ~3KB and every open needs
// a round trip anyway - to bill it, to count it, and to find out whether the
// crowd has retired the copy we would otherwise have served.

const HANDLERS = {
  // Every video this user has paid for. Decides "Summarise" vs "Summarised".
  async YTS_MINE_IDS() {
    const res = await api.myVideos();
    if (!res || !res.ok) return { ok: false, ids: [] };
    return { ok: true, ids: res.videoIds };
  },

  async YTS_QUOTA() {
    const res = await api.quota();
    return res && res.ok ? { ok: true, quota: res.quota } : { ok: false };
  },

  async YTS_VOTE(message) {
    const res = await api.vote(message.videoId, message.vote);
    if (!res || !res.ok) return { ok: false };
    return {
      ok: true,
      vote: res.stats.yourVote,
      stats: res.stats,
      // The server owns the threshold and the one-rewrite cap; the client just
      // reports what it decided.
      retired: !!res.retired,
      exhausted: !!res.exhausted,
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

// Streaming needs a long-lived channel: sendMessage only carries one reply, so
// deltas arrive over a Port instead.
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
      const result = await summariseStream(msg.videoId, msg.durationSeconds || 0, (markdown) =>
        post({ type: 'delta', text: markdown })
      );

      if (!result.ok) {
        console.warn('[yts:sw] summarise refused for %s: %s', msg.videoId, result.code);
        post({ type: 'error', code: result.code, error: result.error, quota: result.quota });
        return;
      }

      console.log(
        '[yts:sw] %s %s',
        msg.videoId,
        result.generated ? 'generated' : 'served from the shared store'
      );
      post({ type: 'done', result });
    } catch (err) {
      console.error('[yts:sw] stream handler failed', err);
      post({ type: 'error', code: 'INTERNAL', error: err.message });
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

console.log('[yts:sw] service worker ready');
