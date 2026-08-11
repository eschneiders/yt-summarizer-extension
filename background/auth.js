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
// An MV3 service worker is torn down after 30 seconds with nothing to do, and
// an account chooser followed by a consent screen routinely takes longer than
// that. Awaiting a promise is not "something to do" - but calling an extension
// API is, and it resets the timer. So ping one while Google's window is open.
//
// Without this the worker can be killed mid-flow: the code comes back to
// nothing, our server never sees a request, and the sign-in appears to do
// absolutely nothing - no error, no session, no log line anywhere.
function keepWorkerAlive() {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  return () => clearInterval(timer);
}

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

  // Every step announces itself. When a sign-in goes wrong the useful question
  // is "how far did it get", and the answer should be readable in the [yts:sw]
  // console without anyone having to add logging first.
  console.log('[yts:sw] sign-in: opening Google, redirect %s', uri);

  const stopKeepAlive = keepWorkerAlive();
  try {
    let redirected;
    try {
      redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    } catch (err) {
      // Closing the window lands here too, which is not an error worth shouting
      // about - it is someone changing their mind.
      console.warn('[yts:sw] sign-in: flow did not complete - %s', err.message);
      return { ok: false, cancelled: true, error: err.message };
    }

    const params = new URL(redirected).searchParams;
    if (params.get('error')) {
      console.error('[yts:sw] sign-in: Google refused - %s', params.get('error'));
      return { ok: false, error: `Google refused: ${params.get('error')}` };
    }
    const code = params.get('code');
    if (!code) return { ok: false, error: 'Google did not return a sign-in code.' };

    console.log('[yts:sw] sign-in: got a code, exchanging it at %s', base);
    let res;
    try {
      res = await fetch(`${base}/v1/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: uri }),
      });
    } catch (err) {
      // The service was unreachable. Distinct from the service saying no, and
      // it used to surface as an unhandled rejection and no reply at all.
      console.error('[yts:sw] sign-in: could not reach %s - %s', base, err.message);
      return { ok: false, error: `Could not reach the service at ${base}: ${err.message}` };
    }

    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      console.error('[yts:sw] sign-in: service refused - HTTP %d %o', res.status, json);
      return {
        ok: false,
        error: json.error || `Sign-in failed (HTTP ${res.status}).`,
        code: json.code,
      };
    }

    await chrome.storage.local.set({
      sessionToken: json.sessionToken,
      authUser: { email: json.user.email, plan: json.user.plan },
    });
    console.log('[yts:sw] signed in as %s (%s)', json.user.email, json.user.plan);
    return { ok: true, user: json.user };
  } finally {
    stopKeepAlive();
  }
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
