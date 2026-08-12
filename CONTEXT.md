# Feed Summariser — context for a fresh session

Paste this at the start of a new chat.

---

I'm building a Chrome extension (Manifest V3) plus its backend, in one repo at
`~/yt-summarizer-extension` (GitHub: `eschneiders/yt-summarizer-extension`).

The extension adds a **Summarise** button to YouTube video cards; clicking it
opens an AI-written summary inline, with clickable timestamps. It works end to
end and is deployed. I'm now finishing the last steps to get it in front of
friends.

---

## The one idea everything else follows from

**A video is summarised once, and everyone who opens it afterwards reads that
same stored copy.** That shared store is the entire cost model — the second and
thousandth reader cost nothing to serve. Measured rate: **~92 minutes of video
per US cent** (from real billing: 120 videos, ~20 min each, $0.26).

Consequences that shaped the design, and shouldn't be undone:

- **Reading a summary you didn't generate still costs you your weekly minutes**,
  even though it costs the service nothing. Otherwise the allowance is trivially
  bypassed by waiting for someone else to summarise something.
- **There is no "Re-summarise" button.** Letting each reader pay to redo a shared
  summary defeats the economics. Instead: thumbs up/down, and when downvotes
  cross a threshold the summary is retired and regenerated once for everybody.
- **Users are never told whether a summary was freshly generated or served from
  the store.** It's an implementation detail; the only thing they should notice
  is that most summaries appear instantly.
- **There is no anonymous tier.** One was built and removed: five cached
  summaries a day for a signed-out reader. The panel's "sign in, it's free"
  message turned out to persuade well enough on its own, and one identity model
  is far less to reason about than two.

---

## Architecture

```
manifest.json         MV3. Pinned `key` fixes the extension ID (see Deployment).
background/
  service-worker.js   router: SSE proxy, badge, sign-in, votes. No business logic.
  api.js              HTTP client for the server. Bearer session token.
  auth.js             Google sign-in via chrome.identity.launchWebAuthFlow
content/
  surfaces.js         per-surface config — ADD A NEW SURFACE HERE, one entry
  button.js           button create/sync, videoId stamping, skip-hiding
  panel.js            markdown renderer, panel placement, duration scraping
  content.js          entry point, SPA nav, MutationObserver, click handler
  content.css         all classes yts- prefixed
options/              sign in/out, allowance, delete my data (URL under Advanced)
icons/                generated PNGs (16/32/48/128)
docs/                 the public website — GitHub Pages serves this folder
server/               Node, one dependency (`pg`)
  src/index.js        node:http router, CORS, SSE, auth gate, rate limit
  src/summarise.js    THE ONLY PATH THAT SPENDS MONEY — all guards live here
  src/gemini.js       Gemini call + prompt + cost estimation
  src/youtube.js      authoritative video length, YouTube Data API + row cache
  src/auth.js         Google code exchange, sessions, salted user hashing
  src/db.js           all SQL
  src/schema.sql      applied idempotently at boot
  src/notify.js       one Telegram sendMessage call, everything else calls this
  src/digest.js       daily report, spend alerts, critical-failure alerts
  test/api.test.mjs   135 assertions against a live server
```

Content scripts load in manifest order and share one `window.__ytSummarizer`
namespace.

**The extension stores nothing of its own** — no summaries, no votes, no
ownership records. Only the session token and the last-known quota figure. The
server is the single source of truth. Every open is a round trip, which is what
makes billing, the counter and the crowd re-run all correct.

**The server is not optional any more.** It holds the Gemini key. Without it
there are no summaries at all. (An older version of this doc said the opposite —
that was true before the key moved server-side.)

## Surfaces (9, all live)

| Surface | Path | Panel style |
|---|---|---|
| home | `/` | inline accordion, full grid width |
| subscriptions | `/feed/subscriptions` | inline accordion |
| search | `/results` | inline accordion, under the result |
| channel | `…/videos`, `…/streams` | inline accordion (rich grid, same as home) |
| channelHome | `/@handle`, `…/featured` | inline accordion (horizontal shelves) |
| playlist | `/playlist` (incl. Watch Later and Liked) | inline accordion |
| history | `/feed/history` | inline accordion |
| watch | `/watch` | inline, under player above description |
| related | `/watch` (sidebar rail) | popup, closes on outside click |

**Every one of these was one entry in `surfaces.js` and nothing else** — that
file exists so adding a surface never touches the rest of the codebase.

Two things that make it that cheap. A vertical list is just a grid where every
row holds one card, so `panel.js`'s offset-grouping puts the panel directly
under the clicked result with no special case. And non-video cards (channels,
playlists, Shorts shelves, ads) need no filtering: they carry no `/watch?v=`
link, `getVideoId` returns null, `syncCardButton` skips them. Matching loosely
and letting the id decide beats enumerating every renderer YouTube ships —
that list would rot.

Watch Later and Liked videos are not surfaces: `/playlist?list=WL` and
`?list=LL` are the same page type as any playlist, so the `playlist` entry
covers both.

Liked and History were briefly removed because they kept refusing with
`UNKNOWN_DURATION`. That turned out to be `YOUTUBE_API_KEY` being unset, not a
selector problem: without it the server falls back to the client's scraped
duration and refuses whenever the scrape comes back empty — which can happen on
any surface. With the key set the client's scrape is irrelevant, so both were
restored. Worth remembering as a pattern: a failure that looks per-page can be a
server-side config gap.

**Card selectors are deliberately loose and list several renderers.** YouTube is
mid-migration from Polymer renderers to lockup/view-model markup and ships
whichever per page and per rollout — the first playlist attempt used only
`ytd-playlist-video-renderer` and matched nothing, because that page had already
moved to `yt-lockup-view-model`. Listing all plausible renderers costs nothing,
because `getVideoId` skips anything without a `/watch?v=` link. `channel` matches on the path
*ending* because a channel is reachable as `/@handle`, `/channel/UC…`, `/c/name`
or `/user/name`, and all four end the same way.

Lazy loading is already handled and needs nothing per-surface: `processGrid`
runs `document.querySelectorAll(cardSelector)` across the whole page on every
pass, driven by a MutationObserver, a scroll listener and a 2s sweep. New cards
get buttons whichever direction you scroll.

Deliberately not surfaces: Shorts (a summary would be longer than the video),
trending, and hashtag pages.

`/watch` runs **two surfaces at once**, so buttons carry `data-yts-surface` and
the click handler resolves the surface from that stamp, not from the pathname.

---

## Running it

**Server** (needs Postgres):
```bash
createdb yts_test && cd server && npm install && npm start
cd server && npm test      # 135 assertions, in another terminal
```

**Extension**: `chrome://extensions` → Developer mode → Load unpacked. The ID
must read `ejijlnafmeidfeoijhhofplnjhfblfdh` — if it doesn't, the manifest `key`
is missing and OAuth will break.

**After any change: reload the extension AND hard-reload the YouTube tab
(Cmd+Shift+R).** Extension reload alone leaves orphaned content scripts.

Two consoles: `[yts]` on the YouTube page, `[yts:sw]` in a separate window via
the "service worker" link on the extension's card.

**You cannot test the extension yourself** — you can't load an unpacked
extension. I run those and paste results back. Give me exact things to look for.
**The server you can test**, and should.

---

## Deployment

| Piece | Where |
|---|---|
| Server | Railway, `yt-summarizer-extension-production.up.railway.app`, root dir `server` |
| Database | Neon Postgres |
| Website | GitHub Pages from `docs/` → `eschneiders.github.io/yt-summarizer-extension/` |
| OAuth | Google Cloud project "Summariser" (also holds the Gemini key) |
| Extension ID | `ejijlnafmeidfeoijhhofplnjhfblfdh` (pinned via manifest `key`) |
| Redirect URI | `https://ejijlnafmeidfeoijhhofplnjhfblfdh.chromiumapp.org/` |
| Support email | `summariser.ex@gmail.com` |

Private signing key is at `~/yts-secrets/extension-signing-key.pem`, outside the
repo. **Losing it means losing the extension ID.**

**The extension is called "Feed Summariser", not "YouTube Feed Summariser".**
Google's brand guidelines forbid a third-party product name beginning with or
dominated by "YouTube" — it implies endorsement, and it is a common Web Store
rejection. Referential use in *copy* is fine and stays ("adds a Summarise button
to YouTube video cards"); the name is what mattered. `terms.html` disclaims
affiliation with YouTube and Google, which should stay. The repo, the Railway
host and the Pages URL keep their old slugs on purpose: they are infrastructure,
not branding, and the Pages URL is already registered as the OAuth consent
screen's privacy-policy link.

Railway environment: `DATABASE_URL`, `YTS_DATABASE_SSL=true`, `GEMINI_API_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_API_KEY`,
`YTS_DAILY_SPEND_CAP_USD=2`, `YTS_WEEKLY_QUOTA_MINUTES=400`,
`YTS_FREE_MAX_VIDEO_MINUTES=60` (the paywall knob),
`YTS_ALLOWED_ORIGINS=chrome-extension://ejijl…`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT=8787`.

Cost: ~$5/mo Railway, $0 Neon free tier, $0 Pages, plus a few dollars of Gemini.

---

## Gemini API facts — hard-won, please don't re-derive

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  (NOT `models/{model}:generateContent` — different request/response shape)
- Model in the **body**, not the URL. Auth header `x-goog-api-key`.
- Model: `gemini-3.5-flash-lite` — cheapest video-capable tier
- Input is `input: [{type:'video', uri, resolution:'low'}]` — no text part;
  instructions go in the top-level `system_instruction` field
- Output text is at `output_text` (fallback: walk `steps[].content[].text`)
- Usage at `usage.{total_input_tokens,total_output_tokens,total_thought_tokens}`
  — **thinking tokens are counted separately from output**, not a subset
- **`temperature` / `top_p` / `top_k` do not exist on this endpoint.** Only
  `seed` and `thinking_level` in `generation_config`.
- Streaming: `stream: true`, SSE. Event payload shapes are NOT documented with
  concrete examples, so `extractDeltaText()` is defensive. Blocking fallback
  exists if streaming fails.
- The hardcoded prices **overstate real spend by ~4x**. Trust the measured
  92 min/cent figure, not `estimateCost`. The spend cap uses the overstated
  numbers deliberately — erring towards stopping early is the right direction.
  The **daily report does not**: it prices a day from video seconds at
  `config.measuredMinutesPerCent`, because a report answers "what did I spend"
  and the cap answers "what is the worst case". Both figures appear in a spend
  alert so the two can never be confused. There is **no API for a Gemini key's
  real balance or spend** — Cloud Billing export is the only route and it is not
  worth the machinery, so the measured rate is the honest best available.
- YouTube's `/api/timedtext` is dead for this purpose — HTTP 200 with a
  zero-length body without a proof-of-origin token. Don't suggest transcript
  scraping; that's why we send the URL to Gemini instead.

## Decisions that took real work — don't undo casually

- **Free-form markdown, no JSON response schema.** A schema flattened the output
  — figures and names got compressed away to fit fields. `panel.js` parses
  markdown and builds DOM with `textContent` (never `innerHTML`).
- **The prompt took 9 rounds of A/B testing**, each candidate run twice because
  run-to-run variance exceeded the difference between prompts. Notable finding:
  *restating a rule made it LESS likely to be followed.* **Don't "improve" the
  prompt by adding emphasis or restating rules.**
- **Feed sweeps are throttled with a maxWait, not debounced.** A YouTube feed
  mutates continuously while scrolling, so a pure trailing debounce is starved
  for exactly as long as the user keeps scrolling — that's why buttons never
  appeared on cards further down. See `scheduler()` in `content.js`.
- **Duration is scraped from several candidate badges**, taking the first whose
  text is a timestamp, with an anchored aria-label fallback. A loose fallback
  reads "3 hours ago" off an upload date. This broke once and made every card
  bill zero minutes; the server now refuses a request it can't meter.
- **Sessions are opaque random strings, not JWTs.** Every request hits the DB
  anyway for quota, so signing buys nothing and costs revocability.
- **Erasure retains the current week's usage** under a salted hash, so deleting
  your data can't refill your allowance. The hash is one-way and pruned when the
  week rolls over.
- **Dedupe by videoId, never by "does a button exist".** The grid virtualises
  and recycles card nodes.
- CSS uses `max-height` + `overflow:hidden` for the collapse animation, so
  content past `max-height` is **silently clipped with no scrollbar**.

## Knowing when it breaks

`incidents` table, one row per (UTC day, kind), with a count and the most recent
message. **One Telegram alert per day, across all kinds** — a second failure the
same day is counted but stays quiet, because one is already enough to mean "go
and look". The morning report lists everything that broke, with detail, and is
meant to be pasted straight into a coding agent.

What counts as critical (`CRITICAL` in `digest.js`): Gemini failing on **both**
the streaming and blocking paths, a YouTube duration lookup failing, Google
refusing the sign-in code exchange, an unhandled error on the summarise path,
and **the extension reporting that YouTube's layout changed**.

That last one is the only way this is knowable. Every selector in `surfaces.js`
is a bet on YouTube's markup; when it stops paying, nothing errors — the
extension just renders no buttons and looks uninstalled, while the server sees
perfectly healthy traffic right up until nobody sends any. So `content.js`
watches for "YouTube has clearly rendered videos and our selector matched none
of them", three sweeps running, and posts once per surface per page load to
`POST /v1/telemetry`.

YouTube API units are counted per **Pacific** day (`api_usage`) because that is
when Google resets the 10,000/day quota — a UTC counter would be out of step for
the last eight hours of every day. A one-off Telegram heads-up fires at 5,000
(`YTS_YOUTUBE_QUOTA_WARN`), so "are we close?" is answered before the answer
becomes "yes, and new videos are already being refused".

To hand a problem to a coding agent:

```sql
SELECT day, kind, count, sample FROM incidents ORDER BY last_at DESC LIMIT 20;
```

## Deploying without breaking the instance already running

Railway overlaps instances during a redeploy — for about a minute, old and new
both serve traffic against **one** database. Two consequences, both learned the
hard way:

- **Never drop or rename a table in the same deploy that stops using it.**
  Dropping `anon_reads` did exactly this: the new instance ran the migration
  while the old one was still reading that table, so signed-out requests hit
  `relation "anon_reads" does not exist` until the old instance drained. Stop
  using it in one deploy, drop it in a later one.
- **Anything that fires once must claim its turn atomically**, not
  read-then-write — otherwise both instances read the same stale value and both
  act. See `claimSetting` in `db.js`, used by the digest, the spend alert, the
  incident alert and the quota warning.

## Pricing: video length is the paid driver

**$3/month or $30/year.** Annual matters more than it looks: Stripe's fixed
~$0.25 is 8% of a $3 charge and is paid twelve times a year, so annual billing
takes fee drag from ~8% to ~0.8% — nearly a month of revenue per subscriber for
no product work.

Per subscriber on $3 gross: −21% VAT, −Stripe (~1.5% + $0.25) leaves about
**$2.18**, minus a few cents of Gemini. Railway's $5/month needs ~3 subscribers.
Still ~70% margin, but not the 90% the raw Gemini cost suggests — VAT and the
fixed fee are most of what goes.

**Why length and not minutes.** Length is not sold because it is expensive — at
~92 min/cent a three-hour video costs about 2c — but because it is the one limit
a second free Google account cannot get past. Selling quantity would be selling
something both cheap to give and trivially farmed by signing up again. This is
also why the YouTube-account-matching idea was dropped: it would have cost weeks
of sensitive-scope verification and a scarier consent screen to defend a paywall
that should not have been built on minutes in the first place.

Planned split: **free** keeps 400 min/week and gets a length ceiling somewhere
in 20–40 min; **paid** gets long videos, priority and an archive. Not model
quality — that raises unit cost, and there is no room for that at $3.

`YTS_FREE_MAX_VIDEO_MINUTES` is the knob, a Railway variable, live on restart,
no extension update needed (the server owns the rule; the client only sends a
hint). **It stays at 60 until there is something to upgrade to** — a wall with
nothing behind it is just a worse product.

Pick the number from data, not taste. Every video anyone attempts has its real
length cached, so this is the demand distribution:

```sql
SELECT count(*) FILTER (WHERE duration_seconds > 20*60) AS over_20,
       count(*) FILTER (WHERE duration_seconds > 30*60) AS over_30,
       count(*) FILTER (WHERE duration_seconds > 40*60) AS over_40,
       count(*)                                          AS total
FROM videos WHERE duration_seconds IS NOT NULL;
```

Still open before charging anyone: **VAT compliance route.** Stripe + Stripe Tax
(~0.5%, calculates but you register for OSS and file yourself) versus a merchant
of record like Paddle or Lemon Squeezy (~5% + fees, they are the seller and
handle VAT entirely). At a handful of subscribers the MoR cut may well beat ever
touching a VAT return.

## Guards on the money path, outermost first

In `server/src/summarise.js`, in this order and for this reason:

0. **How long is this video?** — asked of the YouTube Data API, not of the
   caller, and cached on the `videos` row so it is one lookup per video ever
   (`server/src/youtube.js`). Every guard below is measured in seconds of video,
   so none of them mean anything if that number is the caller's to choose. Fails
   closed: no answer, no summary. An outage only affects videos nobody has
   summarised yet — anything already generated has its length on the row.
1. **Unknown/zero duration** → refuse. Can't be metered, must not be served.
   Also catches live streams, which report `P0D`, and deleted or private videos,
   which YouTube returns nothing for.
2. **Video length cap** (60 min).
3. **Weekly quota** — skipped for `plan = 'unlimited'`.
4. **Existing summary?** → serve it, bill the reader, never call Gemini.
5. **Daily spend cap** ($2, rolling 24h) — read fresh from Postgres immediately
   before every call, never cached. It's the thing standing between a bug and a
   bill, and it has to hold precisely when something has gone wrong.
6. Service key present, one generation in flight per user.

## Deliberately NOT there

- No user-facing options beyond sign in/out and delete-my-data. The service URL
  has a working default and is folded away under "Advanced" for local dev. No
  model picker.
- No local caching in the extension.
- No archive page.
- `m.youtube.com` is unsupported by design.

---

## Still to do before this is public

1. ~~Daily cost report~~ **Done** — `server/src/digest.js` + `notify.js`. Polled
   every 5 minutes (and once at boot): a report for the UTC day that just
   ended, sent to Telegram, only if there was any activity (a generation, a
   sign-up, or a read) — otherwise silent, as asked. A separate, edge-triggered
   alert fires once when rolling-24h spend crosses 50% of the cap and once more
   when it hits the cap outright; it does not repeat on every poll while spend
   sits above a level, and it does not announce spend dropping back down.
   State (`digest_last_day`, `spend_alert_level`) lives in the `settings`
   table, so a restart mid-day cannot double-send or lose the threshold.
   Bot: **@DailySpend_ytsbot**. Needs `TELEGRAM_BOT_TOKEN` (from @BotFather)
   and `TELEGRAM_CHAT_ID` (message the bot once, then read the id off
   `GET https://api.telegram.org/bot<token>/getUpdates`) set on Railway.
   Without both, this is a no-op and says so at startup - same pattern as
   `YOUTUBE_API_KEY`. Email was asked about and is possible - `notify.js` is
   the one place any second channel would plug in - but nothing is built for
   it, since only Telegram was requested.
2. **Chrome Web Store**: $5 fee, unlisted, data disclosures matching the privacy
   policy. Not started. After publishing, check the assigned extension ID — if
   it differs from the pinned one, add the new `chromiumapp.org` redirect URI.
3. ~~Server-side duration lookup.~~ **Done** — `server/src/youtube.js`. The one
   thing left is operational: create the API key. In the same Google Cloud
   project as the Gemini key, enable **YouTube Data API v3**, make a key
   restricted to that one API, and set `YOUTUBE_API_KEY` on Railway. **Until
   that variable is set the server still believes the client**, and says so in
   its first log lines. **Set it before strangers get the link.**
4. `YTS_ALLOWED_ORIGINS` must not be `*` in production.
5. Store link placeholder in `docs/index.html` (the only remaining TODO there).

## Known / suspected issues

- Related-rail and watch-page selectors have fallback lists but were verified on
  one YouTube rollout; they log which selector matched.
- The grid sweep runs `document.querySelectorAll(cardSelector)` every 2s per
  surface plus on scroll. Cheap per card, never profiled on a very long feed.
- Panel placement under fast scrolling on grid surfaces is the most likely
  fragile spot.
- Test videos summarised before the duration fix are recorded as viewed but were
  never billed, so they're permanently free for that account. Test data only.

## The thing I want to do next

<!-- describe it here -->
