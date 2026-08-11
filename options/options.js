const serviceInput = document.getElementById('service');
const statusEl = document.getElementById('status');
const quotaEl = document.getElementById('quota');
const accountEl = document.getElementById('account');
const signInBtn = document.getElementById('signin');
const signOutBtn = document.getElementById('signout');

function setStatus(text) {
  statusEl.textContent = text;
  if (text) setTimeout(() => (statusEl.textContent = ''), 2500);
}

const minutes = (seconds) =>
  Number.isFinite(seconds) ? `${Math.round(seconds / 60)} min` : 'unlimited';

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
  if (!baseUrl()) {
    accountEl.textContent = 'Set a service URL first.';
    signInBtn.disabled = true;
    return;
  }
  signInBtn.disabled = false;

  const state = await ask('YTS_AUTH_STATE');
  const signedIn = state && state.signedIn;

  signInBtn.hidden = signedIn;
  signOutBtn.hidden = !signedIn;

  if (!signedIn) {
    accountEl.textContent = 'Not signed in. Summaries need an account.';
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
  setStatus('Opening Google…');
  const res = await ask('YTS_SIGN_IN');
  signInBtn.disabled = false;
  // Closing the Google window is a decision, not a failure worth reporting.
  if (res && res.ok) setStatus('Signed in.');
  else if (res && !res.cancelled) setStatus(res.error || 'Sign-in failed.');
  else setStatus('');
  refreshAccount();
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
