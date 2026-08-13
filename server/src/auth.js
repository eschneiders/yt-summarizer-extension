import { randomBytes, createHash } from 'node:crypto';

import { config } from './config.js';
import { pool } from './db.js';
import { reportCritical, CRITICAL } from './digest.js';
import { notify } from './notify.js';

// Google sign-in, authorisation-code flow.
//
// The extension never holds the client secret and never talks to Google's
// token endpoint. It obtains a one-time code through chrome.identity and hands
// that here; this server exchanges it, using the secret, for an identity. That
// is the whole reason for the extra hop - a secret shipped inside an extension
// is not a secret, it is a string in a zip file anyone can download.

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DAY_MS = 86400000;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- the salt ----------
//
// Lives in the database rather than in an environment variable: it has to be
// stable forever (a changed salt silently un-retires everyone's spent usage)
// and there is no reason for a human to ever see or set it.
let cachedSalt = null;

async function userHashSalt() {
  if (cachedSalt) return cachedSalt;
  const fresh = randomBytes(32).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO settings (key, value) VALUES ('user_hash_salt', $1)
     ON CONFLICT (key) DO UPDATE SET value = settings.value
     RETURNING value`,
    [fresh]
  );
  cachedSalt = rows[0].value;
  return cachedSalt;
}

// One-way, salted. Enough to recognise a returning account without storing
// anything that identifies it.
export async function hashUserId(userId) {
  const salt = await userHashSalt();
  return createHash('sha256').update(salt).update(userId).digest('hex');
}

// ---------- sign in ----------

// Swaps the one-time code for an ID token. The response comes straight from
// Google's token endpoint over TLS, in reply to a request authenticated with
// our client secret, so its signature does not need separate verification -
// this is what Google's own documentation says to rely on. A token arriving by
// any other route would need the full JWKS check.
async function exchangeCode(code, codeVerifier, redirectUri) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.id_token) {
    // Google's error bodies are terse but the description is usually the whole
    // answer ("redirect_uri_mismatch" and so on), so keep it in the log.
    console.warn(
      '[yts:api] code exchange refused: %s %s',
      payload.error || res.status,
      payload.error_description || ''
    );
    // A wrong secret or an unregistered redirect URI locks every single person
    // out, and looks like nothing at all from the outside - exactly the failure
    // that took an evening to find by hand once already.
    reportCritical(
      CRITICAL.AUTH,
      `${payload.error || res.status} ${payload.error_description || ''}`.trim()
    );
    throw new AuthError('EXCHANGE_FAILED', 'Google would not accept that sign-in.');
  }
  return payload.id_token;
}

function decodeIdToken(idToken) {
  const [, body] = String(idToken).split('.');
  if (!body) throw new AuthError('BAD_TOKEN', 'Malformed identity token.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));

  // Cheap sanity checks. The signature is already established by where the
  // token came from; these catch a token minted for a different application.
  if (claims.aud !== config.googleClientId) {
    throw new AuthError('BAD_TOKEN', 'That sign-in was issued for a different app.');
  }
  if (!claims.sub) throw new AuthError('BAD_TOKEN', 'Identity token has no subject.');
  return claims;
}

async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await pool.query(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [token, userId, now, now + config.sessionDays * DAY_MS]
  );
  return token;
}

export async function signInWithGoogle({ code, codeVerifier, redirectUri }) {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new AuthError('NOT_CONFIGURED', 'Sign-in is not configured on this server.');
  }
  if (!code || !codeVerifier || !redirectUri) {
    throw new AuthError('BAD_REQUEST', 'Missing code, verifier or redirect URI.');
  }

  const claims = decodeIdToken(await exchangeCode(code, codeVerifier, redirectUri));
  const now = Date.now();

  // The email is stored for support and for recognising an account; the `sub`
  // is what everything is actually keyed on, because people change their email
  // and Google keeps the subject stable.
  const { rows } = await pool.query(
    `INSERT INTO users (user_id, email, created_at, last_seen_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, last_seen_at = $3
     RETURNING user_id, email, plan, created_at`,
    [claims.sub, claims.email || null, now]
  );

  const user = rows[0];

  // created_at is only ever set on the INSERT branch above - a returning user
  // hits the UPDATE branch and keeps their original value - so this is true
  // exactly once per account, on the sign-up that created it. Same test the
  // daily digest already uses to count "new sign-ups" for a window, here
  // applied to a window of one moment so it can fire immediately instead of
  // waiting for the next report.
  //
  // TEMPORARY: worth an instant ping while sign-ups are rare enough to be
  // genuinely exciting. Remove once there are enough that this becomes noise
  // rather than news - the daily and on-demand reports already count new
  // sign-ups, so nothing is lost by dropping this later.
  if (user.created_at === now) {
    notify(`New sign-up: ${user.email || '(no email on file)'}`);
  }

  return { sessionToken: await createSession(user.user_id), user };
}

// ---------- using a session ----------

export async function resolveSession(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.user_id, s.expires_at, u.plan, u.email
       FROM sessions s JOIN users u ON u.user_id = s.user_id
      WHERE s.token = $1`,
    [token]
  );
  if (!rows.length) return null;

  const row = rows[0];
  if (row.expires_at <= Date.now()) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  return {
    userId: row.user_id,
    plan: row.plan,
    email: row.email,
    // Carried on every request so readQuota can count usage retired by a
    // previous deletion of this same account. Cheap: a sha256 over a cached
    // salt, and it saves every caller having to remember to look it up.
    userHash: await hashUserId(row.user_id),
  };
}

export async function signOut(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// Expired rows are dead weight and, until they are gone, a token that has been
// rejected is still sitting in the table.
export async function pruneSessions() {
  const { rowCount } = await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [
    Date.now(),
  ]);
  if (rowCount) console.log('[yts:api] pruned %d expired session(s)', rowCount);
}
