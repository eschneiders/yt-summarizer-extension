// Google sign-in from the extension side.
//
// This runs the authorisation-code flow and hands the resulting one-time code
// to our server, which exchanges it using the client secret. The secret is
// never here: an extension is a zip file anyone can download and read, so a
// secret shipped inside one is not a secret. What comes back is an opaque
// session token, which is what every subsequent request carries.

// Public by design - it ships in this file and is visible to anyone who
// installs the extension. That is what a client id is for.
const GOOGLE_CLIENT_ID =
  '791931860880-jjg338dmb0h9f5pcm0qlrobst45mq4kv.apps.googleusercontent.com';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// Only what is needed to tell one person from another. Anything beyond these
// three is a "sensitive" scope in Google's terms and triggers a verification
// review that takes weeks - so if this list ever grows, that is a decision, not
// a detail.
const SCOPES = 'openid email profile';

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// PKCE. The client secret already makes this a confidential exchange, so this
// is belt and braces - it stops a code intercepted from the redirect being
// usable by anyone who did not start the flow.
async function makePkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function redirectUri() {
  // https://<extension-id>.chromiumapp.org/ - not a real host. Chrome
  // intercepts it, which is how the flow returns without a server.
  return chrome.identity.getRedirectURL();
}

export async function getSessionToken() {
  const { sessionToken } = await chrome.storage.local.get(['sessionToken']);
  return sessionToken || null;
}

export async function getUser() {
  const { authUser } = await chrome.storage.local.get(['authUser']);
  return authUser || null;
}

async function serviceBase() {
  const { serviceUrl } = await chrome.storage.local.get(['serviceUrl']);
  return (serviceUrl || '').trim().replace(/\/+$/, '');
}

/**
 * Opens Google's sign-in window and trades the result for a session.
 *
 * `interactive: true` shows the account chooser. There is deliberately no
 * silent variant: this flow only runs when someone has asked to sign in, and a
 * window appearing unbidden is worse than an error message.
 */
export async function signIn() {
  const base = await serviceBase();
  if (!base) return { ok: false, error: 'No service URL configured.' };

  const { verifier, challenge } = await makePkce();
  const uri = redirectUri();

  const authUrl =
    `${AUTH_URL}?` +
    new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: uri,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Without this Google skips the consent screen on repeat sign-ins, which
      // is fine, but it also omits the account chooser - and people with more
      // than one Google account expect to be asked which.
      prompt: 'select_account',
    });

  let redirected;
  try {
    redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (err) {
    // Closing the window lands here too, which is not an error worth shouting
    // about - it is someone changing their mind.
    return { ok: false, cancelled: true, error: err.message };
  }

  const params = new URL(redirected).searchParams;
  if (params.get('error')) {
    return { ok: false, error: `Google refused: ${params.get('error')}` };
  }
  const code = params.get('code');
  if (!code) return { ok: false, error: 'Google did not return a sign-in code.' };

  const res = await fetch(`${base}/v1/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: uri }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) return { ok: false, error: json.error || `Sign-in failed (HTTP ${res.status}).` };

  await chrome.storage.local.set({
    sessionToken: json.sessionToken,
    authUser: { email: json.user.email, plan: json.user.plan },
  });
  console.log('[yts:sw] signed in as %s (%s)', json.user.email, json.user.plan);
  return { ok: true, user: json.user };
}

export async function signOut() {
  const base = await serviceBase();
  const token = await getSessionToken();
  if (base && token) {
    // Best effort: the local session goes either way, so a server that cannot
    // be reached must not leave someone stuck signed in.
    await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  await chrome.storage.local.remove(['sessionToken', 'authUser', 'quota']);
}
