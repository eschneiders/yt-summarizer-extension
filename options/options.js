const serviceInput = document.getElementById('service');
const statusEl = document.getElementById('status');
const quotaEl = document.getElementById('quota');

function setStatus(text) {
  statusEl.textContent = text;
  if (text) setTimeout(() => (statusEl.textContent = ''), 2500);
}

const minutes = (seconds) => `${Math.round(seconds / 60)} min`;

function baseUrl() {
  return serviceInput.value.trim().replace(/\/+$/, '');
}

async function request(path, method = 'GET') {
  const base = baseUrl();
  const { ytsUserId } = await chrome.storage.local.get(['ytsUserId']);
  if (!base || !ytsUserId) return null;
  const res = await fetch(`${base}${path}`, { method, headers: { 'X-Yts-User': ytsUserId } });
  return res.json();
}

// Read from the service rather than from anything stored here: the whole point
// of a server-side allowance is that the client is not the source of truth.
async function loadQuota() {
  if (!baseUrl()) {
    quotaEl.textContent = 'No service configured — summaries are unavailable.';
    return;
  }

  const { ytsUserId } = await chrome.storage.local.get(['ytsUserId']);
  if (!ytsUserId) {
    quotaEl.textContent = 'Not connected yet — summarise a video to register this browser.';
    return;
  }

  quotaEl.textContent = 'Checking…';
  try {
    const json = await request('/v1/me/quota');
    if (!json || !json.ok) throw new Error((json && json.error) || 'unexpected response');
    const q = json.quota;
    quotaEl.textContent =
      `${minutes(q.usedSeconds)} of ${minutes(q.limitSeconds)} used this week · ` +
      `resets ${new Date(q.resetsAt).toLocaleDateString()}`;
  } catch (err) {
    quotaEl.textContent = `Could not reach the service (${err.message}).`;
  }
}

async function load() {
  const { serviceUrl } = await chrome.storage.local.get(['serviceUrl']);
  if (serviceUrl) serviceInput.value = serviceUrl;
  loadQuota();
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serviceUrl: baseUrl() });
  setStatus('Saved.');
  loadQuota();
  // Pointing at a different service means a different allowance, so the
  // number on the toolbar icon is now wrong until it is re-read.
  chrome.runtime.sendMessage({ type: 'YTS_REFRESH_BADGE' });
});

document.getElementById('delete').addEventListener('click', async () => {
  if (!confirm('Delete everything the service knows about you? This cannot be undone.')) return;
  try {
    const json = await request('/v1/me', 'DELETE');
    if (!json || !json.ok) throw new Error((json && json.error) || 'unexpected response');
    // The local id goes too, otherwise the next request silently recreates the
    // same account and "deleted" would not mean much.
    await chrome.storage.local.remove('ytsUserId');
    setStatus('Deleted.');
    loadQuota();
    chrome.runtime.sendMessage({ type: 'YTS_REFRESH_BADGE' });
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
  }
});

load();
