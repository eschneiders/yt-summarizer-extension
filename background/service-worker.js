import { api, summariseStream } from './api.js';
import { signIn, signOut, getUser, getSessionToken } from './auth.js';

// This used to hold the Gemini key, a summary cache, a vote store and a list of
// which videos were "yours". All of it now lives on the server, because all of
// it was either money or a number that has to be the same for everyone. What is
// left is a router: content scripts cannot make cross-origin requests or open
// tabs, so those go through here.
//
// Nothing is cached locally on purpose. A summary is ~3KB and every open needs
// a round trip anyway - to bill it, to count it, and to find out whether the
// crowd has retired the copy we would otherwise have served.

// ---------- the toolbar badge ----------
//
// The weekly allowance shown on the icon. Account state belongs somewhere
// account-level, and the icon is glanceable without opening anything - the
// copy in the summary panel answers "what is this costing me right now",
// this one answers "where am I generally".

const BADGE_LOW_FRACTION = 0.15;

async function paintBadge(quota) {
  if (!quota) {
    // No service configured, or unreachable. An empty badge is honest; a stale
    // number would not be.
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'YouTube Feed Summariser' });
    return;
  }

  const left = Math.round(quota.remainingSeconds / 60);
  const limit = Math.round(quota.limitSeconds / 60);
  const low = quota.remainingSeconds <= quota.limitSeconds * BADGE_LOW_FRACTION;

  // A badge fits about four characters, so a large or unlimited allowance gets
  // the short form rather than being silently truncated to something wrong.
  const text = left > 1000 ? '1k+' : String(left);

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: low ? '#c2410c' : '#3f3f46' });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({
    title: Number.isFinite(limit)
      ? `YouTube Feed Summariser — ${left} of ${limit} minutes left this week`
      : `YouTube Feed Summariser — ${left} minutes used this week, no limit`,
  });
}

// The single place the current allowance lives on this machine. Everything
// that displays it - the badge, the settings page, any open summary panel -
// reads from here and reacts to it changing, rather than each holding its own
// copy that goes stale the moment a summary is generated somewhere else.
async function rememberQuota(quota) {
  await chrome.storage.local.set({ quota: quota || null });
  await paintBadge(quota);
}

async function refreshBadge() {
  const res = await api.quota();
  await rememberQuota(res && res.ok ? res.quota : null);
}

// MV3 evicts the worker when idle, but badge text is browser state and
// survives that. These cover the cases where it would otherwise be stale or
// blank: a fresh install, a browser restart, and a changed service URL.
chrome.runtime.onInstalled.addListener(() => refreshBadge());
chrome.runtime.onStartup.addListener(() => refreshBadge());

// No popup, so a click has to do something useful.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const HANDLERS = {
  // Sign-in has to run here rather than in the options page: launchWebAuthFlow
  // needs the extension context, and the resulting session belongs to the
  // whole extension rather than to whichever page happened to ask.
  async YTS_SIGN_IN() {
    const result = await signIn();
    if (result.ok) await refreshBadge();
    return result;
  },

  async YTS_SIGN_OUT() {
    await signOut();
    await paintBadge(null);
    return { ok: true };
  },

  async YTS_AUTH_STATE() {
    return { ok: true, signedIn: !!(await getSessionToken()), user: await getUser() };
  },

  // Erasure signs you out as well: the server drops the session along with
  // everything else, so keeping a dead token here would only produce
  // confusing 401s.
  async YTS_DELETE_ME() {
    const res = await api.deleteMe();
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'request failed' };
    await signOut();
    await paintBadge(null);
    return { ok: true, ...res };
  },

  async YTS_REFRESH_BADGE() {
    await refreshBadge();
    return { ok: true };
  },

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
      // The response already carries the new balance, so everything that shows
      // it updates without a second request.
      if (result.quota) await rememberQuota(result.quota);
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
