const serviceInput = document.getElementById('service');
const statusEl = document.getElementById('status');
const authStatusEl = document.getElementById('authStatus');
const quotaEl = document.getElementById('quota');
const accountEl = document.getElementById('account');
const signInBtn = document.getElementById('signin');
const signOutBtn = document.getElementById('signout');

// Success fades; failure stays put. A message that erases itself after two and
// a half seconds is fine for "Saved." and useless for an error someone is meant
// to act on - especially a sign-in error, which arrives while they are looking
// at Google's window rather than at this page.
function write(el, text, { sticky = false } = {}) {
  el.textContent = text;
  el.classList.toggle('yts-error-text', sticky && !!text);
  if (text && !sticky) setTimeout(() => (el.textContent = ''), 2500);
}

const setStatus = (text, opts) => write(statusEl, text, opts);
const setAuthStatus = (text, opts) => write(authStatusEl, text, opts);

const minutes = (seconds) => {
  if (!Number.isFinite(seconds)) return 'unlimited';
  const m = Math.round(seconds / 60);
  return m > 1000 ? '1000+ min' : `${m} min`;
};

const baseUrl = () => serviceInput.value.trim().replace(/\/+$/, '');

// The service worker owns the session, so everything that needs it goes
// through a message rather than this page reading the token itself. One place
// that knows how to sign in is easier to keep correct than two.
const ask = (type) => chrome.runtime.sendMessage({ type });

function showQuota(q) {
  if (!q) {
    quotaEl.textContent = '—';
    return;
  }
  quotaEl.textContent = q.unlimited
    ? `${minutes(q.usedSeconds)} used this week · no limit on your account`
    : `${minutes(q.usedSeconds)} of ${minutes(q.limitSeconds)} used this week · ` +
      `resets ${new Date(q.resetsAt).toLocaleDateString()}`;
}

// This page can sit open while you summarise things in another tab, so it
// follows the stored figure rather than showing whatever was true when it
// loaded.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.quota) showQuota(changes.quota.newValue);
});

async function refreshAccount() {
  // The service URL now has a working default, so an empty one means someone
  // has deliberately cleared it in Advanced.
  if (!baseUrl()) {
    accountEl.textContent = 'No service URL set — see Advanced below.';
    signInBtn.disabled = true;
    return;
  }
  signInBtn.disabled = false;

  const state = await ask('YTS_AUTH_STATE');
  const signedIn = state && state.signedIn;

  signInBtn.hidden = signedIn;
  signOutBtn.hidden = !signedIn;

  if (!signedIn) {
    accountEl.textContent =
      'Not signed in. Summaries need an account — it is free, and it is only so ' +
      'one person cannot use up the whole service.';
    quotaEl.textContent = '—';
    return;
  }

  const user = state.user || {};
  accountEl.textContent =
    `Signed in as ${user.email || 'your Google account'}` +
    (user.plan && user.plan !== 'free' ? ` · ${user.plan}` : '');

  // Ask the worker to re-read the allowance; the storage listener above paints
  // whatever comes back.
  ask('YTS_REFRESH_BADGE');
}

async function load() {
  const { serviceUrl, quota } = await chrome.storage.local.get(['serviceUrl', 'quota']);
  if (serviceUrl) serviceInput.value = serviceUrl;
  if (quota) showQuota(quota);
  refreshAccount();
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serviceUrl: baseUrl() });
  setStatus('Saved.');
  refreshAccount();
});

signInBtn.addEventListener('click', async () => {
  signInBtn.disabled = true;
  setAuthStatus('Opening Google…');

  // An exception here used to leave the button disabled with the status stuck
  // on "Opening Google…", which reads exactly like a hang.
  let res;
  try {
    res = await ask('YTS_SIGN_IN');
  } catch (err) {
    res = { ok: false, error: `The extension's background worker did not answer: ${err.message}` };
  }
  signInBtn.disabled = false;
  console.log('[yts:options] sign-in result:', res);

  if (res && res.ok) {
    setAuthStatus('Signed in.');
  } else if (res && res.cancelled) {
    // Closing the Google window is a decision, not a failure worth reporting.
    setAuthStatus('');
  } else if (res) {
    setAuthStatus(res.error || 'Sign-in failed.', { sticky: true });
  } else {
    // No reply at all. In MV3 this is usually the service worker being torn
    // down while Google's window was open - the sign-in itself may well have
    // succeeded, so say what is actually known rather than "failed".
    // refreshAccount() below reads the stored session and settles it either way.
    setAuthStatus(
      'Lost contact with the extension while Google was open. Checking whether it worked…',
      { sticky: true }
    );
  }

  await refreshAccount();
  // If the session did land, the line above is stale and alarming - clear it.
  if (!res && (await ask('YTS_AUTH_STATE'))?.signedIn) setAuthStatus('Signed in.');
});

signOutBtn.addEventListener('click', async () => {
  await ask('YTS_SIGN_OUT');
  setStatus('Signed out.');
  refreshAccount();
});

document.getElementById('delete').addEventListener('click', async () => {
  if (!confirm('Delete everything the service knows about you? This cannot be undone.')) return;

  const state = await ask('YTS_AUTH_STATE');
  if (!state || !state.signedIn) return setStatus('Sign in first.');

  try {
    // Deletion needs the session, so it goes through the worker's client.
    const res = await chrome.runtime.sendMessage({ type: 'YTS_DELETE_ME' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'unexpected response');
    setStatus('Deleted.');
    refreshAccount();
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
  }
});

load();
