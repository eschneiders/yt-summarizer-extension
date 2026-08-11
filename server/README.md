# yts-server

The backend for the YouTube Feed Summariser extension. It holds the Gemini key,
generates summaries, and stores one copy of each for everyone to read.

That last part is the whole design. A video is summarised **once**; every reader
after the first gets that same text instantly and for nothing. It is what makes
the free tier affordable, and it is why three of the extension's features have
to live here rather than in the browser:

- **"N others summarised this"** — needs a count across users.
- **Thumbs-down re-runs** — needs everyone's votes in one place to know when a
  summary has been rejected by enough readers.
- **A weekly allowance** — needs a per-user total that survives a cache clear,
  attached to an account rather than a browser.

The extension stores nothing of its own. It is a renderer and a router.

## Running it

Node **22.5+** (25 recommended) and a Postgres database. One dependency (`pg`).

```bash
createdb yts_test && cd server && npm install && npm start
```

`DATABASE_URL` defaults to `postgres://localhost:5432/yts_test`. The schema in
`src/schema.sql` is applied idempotently at boot, so there is nothing to run by
hand. On a hosted database also set `YTS_DATABASE_SSL=true`.

Postgres rather than SQLite for one reason that has nothing to do with scale:
on a container host the filesystem is usually ephemeral, so a SQLite file
quietly vanishes on redeploy unless a volume is mounted exactly right. A
managed database removes that whole class of accident.

Then put `http://localhost:8787` into the extension's options page and sign in.
Without a service URL the extension cannot summarise anything at all — there is
no local fallback any more, because there is no local Gemini key.

## Tests

With the server running in another terminal:

```bash
cd server && npm test
```

71 assertions against a live instance, covering the extension's real
`background/api.js` as well as the HTTP surface: session handling and
revocation, billing rules, quota exhaustion, the unlimited plan, erasure that
cannot refill an allowance, the downvote threshold and its one-rewrite cap, the
spend cap, and the refusal of anything that cannot be metered.

Sessions are created by writing to the database directly rather than through a
test-only endpoint — a backdoor that mints sessions is a backdoor whether or not
it is labelled one. Each run mints fresh ids, so it is safe to re-run against a
database that already has data in it.

## Configuration

All optional, all environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | Pays for every generation. Without it, stored summaries still serve. |
| `GOOGLE_CLIENT_ID` | — | OAuth client. Public; also hardcoded in the extension. |
| `GOOGLE_CLIENT_SECRET` | — | **Secret.** Only this server ever holds it. |
| `YTS_DAILY_SPEND_CAP_USD` | `2` | Hard stop on generations for a rolling 24h |
| `YTS_SESSION_DAYS` | `90` | How long a sign-in lasts |
| `PORT` | `8787` | Listen port |
| `DATABASE_URL` | local `yts_test` | Postgres connection string |
| `YTS_DATABASE_SSL` | `false` | Set `true` on hosted Postgres |
| `YTS_POOL_SIZE` | `10` | Postgres connection pool size |
| `YTS_WEEKLY_QUOTA_MINUTES` | `400` | Free-tier minutes of video per ISO week |
| `YTS_DOWNVOTE_MINIMUM` | `3` | Downvotes needed before a summary can be retired |
| `YTS_DOWNVOTE_RATIO` | `0.6` | Share of votes that must be down |
| `YTS_MAX_REVISION` | `2` | Highest revision reachable — 2 means one rewrite |
| `YTS_ALLOWED_ORIGINS` | `*` | Comma-separated CORS allowlist |
| `YTS_RATE_LIMIT_PER_MINUTE` | `120` | Requests per user per minute |

## API

Every route except `/v1/health` and `POST /v1/auth/google` requires
`Authorization: Bearer <session token>`.

| Route | Returns |
|---|---|
| `GET /v1/health` | `{ok}` |
| `POST /v1/auth/google` | `{ok, sessionToken, user}` |
| `POST /v1/auth/logout` | `{ok}` |
| `GET /v1/me` | `{ok, user, quota}` |
| `GET /v1/me/quota` | `{ok, quota}` |
| `GET /v1/videos/:id` | `{ok, stats, quota}` |
| `POST /v1/videos/:id/view` | `{ok, stats, quota}`, or `429 QUOTA_EXCEEDED` |
| `POST /v1/videos/:id/vote` | `{ok, revision, retired, stats}` |

`stats` is `{videoId, revision, summarisedBy, others, up, down, yourVote, youViewed}`.

### How the re-run works

Votes are recorded against a `revision`. When downvotes cross both thresholds,
the server increments the video's revision, which retires every cached copy of
that summary: clients store the revision alongside the markdown and re-summarise
when the server reports a newer one. Votes on the retired revision stay in the
table but no longer count, so the same three downvotes cannot retire the
replacement too.

**One rewrite, then it stops.** `YTS_MAX_REVISION` caps this at 2 — the original
and its single replacement. If the rewrite is rejected as well, the vote comes
back with `exhausted: true` and nothing further happens. The problem at that
point is a video the model cannot do much with, and paying for attempt three,
four and five at it is throwing money at a wall. Downvotes keep accumulating as
a signal you can query later.

### Who pays for a summary

A summary is generated once and read by many, so **reading one you did not
generate costs you your own minutes**, even though it costs the service nothing
to serve. `youViewed` on the stats response is what the extension keys off: it
shows "Summarised" and skips billing only for videos this user has personally
been billed for. Re-opening your own is always free and never re-billed.

### Signing in

Authorisation-code flow with PKCE. The extension opens Google via
`chrome.identity.launchWebAuthFlow`, gets a one-time code, and posts it here;
this server exchanges it using the client secret and issues an opaque session
token. The secret never reaches the extension — a secret shipped inside a
downloadable zip is not a secret.

Session tokens are random strings in a table, not JWTs. Every request hits the
database anyway to check quota, so a signed token buys nothing and costs the
ability to revoke: deleting the row logs someone out instantly.

### Plans

`users.plan` is `free` or `unlimited`. Unlimited still records usage — you can
see what a friend costs you — but is never refused:

```sql
UPDATE users SET plan = 'unlimited' WHERE email = 'friend@example.com';
```

## Before this is public

1. **The client asserts the video's duration**, and the allowance is metered
   against it. Fine while the only client is ours; a hand-written one could
   claim a three-hour video is sixty seconds. The fix is looking the duration up
   server-side via the YouTube Data API. Do this before strangers get the link.
2. **`YTS_ALLOWED_ORIGINS` defaults to `*`.** Set it to your extension's
   `chrome-extension://<id>` origin.
3. **Set a real `YTS_DAILY_SPEND_CAP_USD`.** It is the only thing between a bug
   and a bill.
