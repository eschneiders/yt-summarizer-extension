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

// Where summaries come from unless someone deliberately points this elsewhere.
// It used to be unset on a fresh install, which meant the settings page opened
// with an empty box, the sign-in button disabled, and no way for anyone but the
// author to know what to type. A default is not a preference - it is the
// difference between an extension that works when installed and one that does
// not.
const DEFAULT_SERVICE_URL = 'https://feedsummariser.duckdns.org';

// MV3 evicts the worker when idle, but badge text is browser state and
// survives that. These cover the cases where it would otherwise be stale or
// blank: a fresh install, a browser restart, and a changed service URL.
// Hosts this extension used to talk to. A stored serviceUrl pointing at one of
// these is not a preference - it is a dead address left behind by a move, and
// updating the extension would not fix it on its own, because the default below
// only ever fills a blank. Without this an existing install keeps calling a host
// that no longer exists and simply looks broken forever.
const RETIRED_SERVICE_HOSTS = [/\.up\.railway\.app$/i];

async function migrateServiceUrl() {
  const { serviceUrl } = await chrome.storage.local.get(['serviceUrl']);
  if (!serviceUrl) {
    await chrome.storage.local.set({ serviceUrl: DEFAULT_SERVICE_URL });
    return;
  }
  let host;
  try {
    host = new URL(serviceUrl).hostname;
  } catch {
    return; // unparseable, leave it alone rather than clobber it
  }
  if (RETIRED_SERVICE_HOSTS.some((re) => re.test(host))) {
    console.log('[yts:sw] service moved: %s -> %s', serviceUrl, DEFAULT_SERVICE_URL);
    await chrome.storage.local.set({ serviceUrl: DEFAULT_SERVICE_URL });
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  // Fills a blank, and rewrites an address we have moved away from. Anyone
  // pointing at localhost for development keeps pointing at localhost.
  await migrateServiceUrl();

  // Summaries need an account, so the first run has to say so somewhere the
  // person is actually looking. Only on a genuine install - reopening this on
  // every background update would be obnoxious.
  if (details.reason === 'install') await chrome.runtime.openOptionsPage();

  await refreshBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await migrateServiceUrl();
  await refreshBadge();
});

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

  // Unlike most of these, a failure here has to reach the user: they pressed a
  // button and are watching a spinner, so "quietly return nothing" would leave
  // it spinning forever. The code is passed through so the panel can tell
  // "summarise it first" apart from a real failure.
  async YTS_MAIN_POINT(message) {
    const res = await api.mainPoint(message.videoId);
    if (!res) {
      return { ok: false, code: 'OFFLINE', error: 'The summariser service is unreachable.' };
    }
    if (!res.ok) {
      return {
        ok: false,
        code: res.code || 'FAILED',
        error: res.error || 'Could not work out the main point.',
      };
    }
    return { ok: true, markdown: res.markdown, generated: !!res.generated };
  },

  // Content scripts cannot call chrome.tabs, so tab opening is proxied here.
  // active:false is what makes "Later" queue a video without stealing focus.
  async YTS_OPEN_TAB(message) {
    await chrome.tabs.create({ url: message.url, active: message.active !== false });
    return { ok: true };
  },

  // The content script reporting that YouTube's markup no longer matches our
  // selectors. Proxied through here because content scripts cannot reach the
  // service directly, and swallowed on failure - a broken extension reporting
  // that it is broken must not also throw.
  async YTS_TELEMETRY(message) {
    await api.telemetry({
      kind: message.kind,
      surface: message.surface,
      detail: message.detail,
    });
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

    // A generation runs for tens of seconds, and this worker is killed after
    // thirty without activity. Deltas usually count as activity - but there is
    // a long silence before the first token while the model thinks, and the
    // blocking fallback produces no deltas at all. When the worker dies the
    // port disconnects and the page reports a failure for a summary that is
    // still being written and will be stored regardless. So hold the worker up
    // for as long as the request is in flight.
    const keepAlive = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, 20000);

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
    } finally {
      clearInterval(keepAlive);
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
