# yts-server

Shared counters for the YouTube Feed Summariser extension. It exists because
three of the extension's features are things no browser can know on its own:

- **"N others summarised this"** — needs a count across users.
- **Thumbs-down re-runs** — needs everyone's votes in one place to know when a
  summary has been rejected by enough readers.
- **300 minutes a week** — needs a per-user total that survives a cache clear.

It does **not** store or generate summaries. Those are still produced by the
extension with the user's own Gemini key and cached in their browser. This
service only holds counters.

## Running it

Node **22.5+** (25 recommended). No dependencies — `node:http` and
`node:sqlite`, nothing to install.

```bash
cd server && npm start
```

Then put `http://localhost:8787` into the extension's options page. Leave that
field empty and the extension runs exactly as it did before this existed: local
cache, local votes, no counter, no limit.

Node still prints an `ExperimentalWarning` for `node:sqlite`. The API is stable
in Node 24+; the warning is noise.

## Tests

With the server running in another terminal:

```bash
cd server && npm test
```

36 assertions against a live instance, covering the extension's real
`background/api.js` as well as the HTTP surface: billing rules, quota
exhaustion, the downvote threshold and its one-rewrite cap, and the degradation
paths when the service is absent or unreachable. Each run mints fresh video and
user ids, so it is safe against a database that already has data in it.

## Configuration

All optional, all environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `YTS_DB_PATH` | `./data/yts.sqlite` | SQLite file |
| `YTS_WEEKLY_QUOTA_MINUTES` | `300` | Free-tier minutes of video per ISO week |
| `YTS_DOWNVOTE_MINIMUM` | `3` | Downvotes needed before a summary can be retired |
| `YTS_DOWNVOTE_RATIO` | `0.6` | Share of votes that must be down |
| `YTS_MAX_REVISION` | `2` | Highest revision reachable — 2 means one rewrite |
| `YTS_ALLOWED_ORIGINS` | `*` | Comma-separated CORS allowlist |
| `YTS_RATE_LIMIT_PER_MINUTE` | `120` | Requests per user per minute |

## API

Every route except `/v1/health` requires an `X-Yts-User: <uuid>` header. The
extension mints that UUID on first use and keeps it in `chrome.storage.local`.

| Route | Returns |
|---|---|
| `GET /v1/health` | `{ok}` |
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

## Before this is public

Two things are deliberately unfinished, and both matter the moment this is not
just your machine:

1. **The user id is asserted, not authenticated.** Anyone can send a fresh UUID
   and get another 300 minutes, or vote as many times as they like from a loop.
   That is tolerable while each user pays for their own Gemini calls — the quota
   is advisory and the votes are low-stakes. It is not tolerable once the server
   pays for anything. That needs real accounts.
2. **`YTS_ALLOWED_ORIGINS` defaults to `*`.** Set it to your extension's
   `chrome-extension://<id>` origin.
