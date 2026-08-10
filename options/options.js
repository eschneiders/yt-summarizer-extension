const keyInput = document.getElementById('key');
const serviceInput = document.getElementById('service');
const reveal = document.getElementById('reveal');
const statusEl = document.getElementById('status');
const quotaEl = document.getElementById('quota');

function setStatus(text) {
  statusEl.textContent = text;
  if (text) setTimeout(() => (statusEl.textContent = ''), 2500);
}

function formatMinutes(seconds) {
  return `${Math.round(seconds / 60)} min`;
}

// Reads the allowance straight from the service rather than from anything
// cached here - the whole point of a server-side quota is that the client is
// not the source of truth for it.
async function loadQuota() {
  const base = serviceInput.value.trim().replace(/\/+$/, '');
  if (!base) {
    quotaEl.textContent = 'Running locally — no weekly limit, no shared counter.';
    return;
  }

  const { ytsUserId } = await chrome.storage.local.get(['ytsUserId']);
  if (!ytsUserId) {
    quotaEl.textContent = 'Not connected yet — summarise one video to register this browser.';
    return;
  }

  quotaEl.textContent = 'Checking…';
  try {
    const res = await fetch(`${base}/v1/me/quota`, { headers: { 'X-Yts-User': ytsUserId } });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    const q = json.quota;
    quotaEl.textContent = `This week: ${formatMinutes(q.usedSeconds)} of ${formatMinutes(
      q.limitSeconds
    )} used · resets ${new Date(q.resetsAt).toLocaleDateString()}`;
  } catch (err) {
    quotaEl.textContent = `Could not reach the service (${err.message}).`;
  }
}

async function load() {
  const { geminiApiKey, serviceUrl } = await chrome.storage.local.get([
    'geminiApiKey',
    'serviceUrl',
  ]);
  if (geminiApiKey) keyInput.value = geminiApiKey;
  if (serviceUrl) serviceInput.value = serviceUrl;
  loadQuota();
}

reveal.addEventListener('change', () => {
  keyInput.type = reveal.checked ? 'text' : 'password';
});

document.getElementById('save').addEventListener('click', async () => {
  const key = keyInput.value.trim();
  const serviceUrl = serviceInput.value.trim().replace(/\/+$/, '');
  await chrome.storage.local.set({ geminiApiKey: key, serviceUrl });
  setStatus('Saved.');
  loadQuota();
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('geminiApiKey');
  keyInput.value = '';
  setStatus('Key cleared.');
});

load();
