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
| Sideload download | `…github.io/yt-summarizer-extension/feed-summariser.zip` (what friends install today) |
| Web Store | Unlisted, **pending review** since 12 Aug 2026, item `hkdafonhnkaegdnnnabobgagdclkeeci` |
| Support email | `summariser.ex@gmail.com` |

**There are TWO extension IDs, and both must stay registered everywhere.**

| ID | Where it comes from |
|---|---|
| `ejijlnafmeidfeoijhhofplnjhfblfdh` | the manifest `key` — every unpacked/sideloaded install |
| `hkdafonhnkaegdnnnabobgagdclkeeci` | assigned by the Web Store — every store install |

Both are in `YTS_ALLOWED_ORIGINS` and both `chromiumapp.org` redirect URIs are
registered on the OAuth client. Verified working. Miss either and that install
route is silently dead: CORS 403 on every request, sign-in impossible, and
nothing in the server log because the requests never arrive.

**`package-extension.sh` builds two different zips on purpose.**
`dist/yt-summariser-<v>.zip` has the `key` **stripped** (the store rejects a
manifest carrying one) and goes to the Web Store. `docs/feed-summariser.zip`
**keeps** the key, because an unpacked install without it gets a random id from
its folder path and is dead on arrival. Never upload one where the other
belongs. The sideload filename is fixed so re-running the script republishes
over the same URL and no shared link goes stale.

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
`YTS_DAILY_SPEND_CAP_USD`, `YTS_WEEKLY_QUOTA_MINUTES`,
`YTS_FREE_MAX_VIDEO_MINUTES`, `YTS_ALLOWED_ORIGINS=chrome-extension://ejijl…`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PORT=8787`.

**The Railway variables are the single source of truth for every limit.** The
three tuning knobs above — daily spend cap, weekly quota minutes, free video
length ceiling — are changed by hand as testing goes on, so this document
deliberately does not name their values: any number written here would be wrong
within the week. Read the current values off Railway (or the server's startup
log) before reasoning about, quoting, or changing a limit, and never treat a
number found elsewhere in the repo as authoritative.

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

**€3/month, one price, every country.** EUR only — a US customer paying in EUR
costs four cents more than one paying in USD, which is not worth a second price
to maintain. No per-country pricing either: with no VAT to absorb (see
"Payments" below) there is no country variance to price around.

Per subscriber on €3, charging no VAT: −€0.295 Stripe (1.5% + €0.25 on an EEA
card), −€0.015 Stripe Billing, leaves about **€2.69**, minus a few cents of
Gemini. A non-EEA card costs 3.25% instead of 1.5% — four cents on €3, ignorable.
Railway's $5/month needs two subscribers.

**If VAT ever applies that becomes €2.15** — see the €20,000 cliff under
"Payments". A 20% cut in per-subscriber revenue, landing mid-year rather than at
a year boundary.

An earlier version of this section argued annual billing was nearly free money,
because the fixed €0.25 is 8% of €3 and annual pays it once instead of twelve
times. **That reasoning is wrong and should not be reinstated.** €30/year is a
17% discount on €36, and the discount gives away more than the fees save: twelve
successful monthly payments net €32.28, one annual payment nets €29.15. Annual
is still worth offering, but for the honest reason — it converts churn and
card-failure risk into cash upfront — not because it beats monthly on fees. Price
it knowing it costs ~€3/subscriber-year when someone would have stayed anyway.

**Why length and not minutes.** Length is not sold because it is expensive — at
~92 min/cent a three-hour video costs about 2c — but because it is the one limit
a second free Google account cannot get past. Selling quantity would be selling
something both cheap to give and trivially farmed by signing up again. This is
also why the YouTube-account-matching idea was dropped: it would have cost weeks
of sensitive-scope verification and a scarier consent screen to defend a paywall
that should not have been built on minutes in the first place.

Planned split: **free** keeps its weekly minutes and gets a video-length
ceiling; **paid** gets long videos, priority and an archive. Not model
quality — that raises unit cost, and there is no room for that at €3.

`YTS_FREE_MAX_VIDEO_MINUTES` is the knob, a Railway variable, live on restart,
no extension update needed (the server owns the rule; the client only sends a
hint). It moves around during testing — see the note under Deployment.

Pick the number from data, not taste. Every video anyone attempts has its real
length cached, so this is the demand distribution:

```sql
SELECT count(*) FILTER (WHERE duration_seconds > 20*60) AS over_20,
       count(*) FILTER (WHERE duration_seconds > 30*60) AS over_30,
       count(*) FILTER (WHERE duration_seconds > 40*60) AS over_40,
       count(*)                                          AS total
FROM videos WHERE duration_seconds IS NOT NULL;
```

## Payments: every decision made, nothing built

Researched and settled August 2026. The paywall itself is **already built** —
`maxVideoSecondsFor(plan)` in `config.js` is wired into `planSummary`, and
setting `plan = 'plus'` on a row in psql gives a working paid tier today. Nothing
below is about the gate. It is all about how a row becomes `'plus'` without
someone typing SQL.

### Processor: Stripe. Not a merchant of record.

The case for an MoR (Paddle, Lemon Squeezy) is that it buys out VAT compliance.
There is no VAT compliance to buy out — see below. And a second reason that
holds regardless of tax: **MoR fixed fees are ruinous on a €3 product.** Paddle's
5% + €0.50 is 22% of €3; Stripe's 1.5% + €0.25 is 10%. Stripe nets €2.69 against
€1.85, 45% more per subscriber. MoRs are built for €30–100 tickets.

An earlier draft said an MoR "wins back" above €10,000 of EU cross-border sales.
**That was wrong.** With VAT applying, Stripe nets €2.15 and an MoR €1.85 — €0.30
per subscriber per month, about €1,080/year at the ~300 subscribers that
threshold implies, against maybe €500–1,500/year for an accountant to run OSS
filings that Stripe Tax has already prepared. Roughly a wash at the crossing
point, and Stripe pulls further ahead every subscriber after, because the MoR's
cost scales with volume and an accountant's does not. Stripe now, Stripe later.

### VAT: none charged, via KOR — not via the €10,000 rule

These are two different rules and conflating them is the easy mistake:

- **The €10,000 threshold waives nothing.** It decides *which country's* VAT
  applies to B2C digital services sold to non-NL EU consumers. Below it they are
  taxed in the Netherlands; above it, in the customer's country, and OSS becomes
  necessary.
- **The waiver is the KOR** — the Dutch kleineondernemersregeling, €20,000 of
  Dutch turnover, under which you charge no VAT and file no returns.

They combine: under €10,000 cross-border, EU sales *are* Dutch turnover, so the
KOR exemption covers Dutch and EU customers with one registration. US customers
are outside EU VAT entirely (non-EU consumer), and US state sales-tax nexus
thresholds (~$100k or 200 transactions per state) are nowhere near.

KOR is **opt-in** — apply to the Belastingdienst, it is not automatic. Since 2025
there is no three-year lock-in. Under it you cannot reclaim input VAT, and
reverse-charge VAT on foreign services bought in (Google, Railway) can still be
owed and not deductible — the one place KOR is not quite "no VAT at all", and
worth one question to an accountant.

| Threshold | Measures | What changes on crossing |
|---|---|---|
| **€10,000** | B2C digital sales to non-NL EU consumers, per calendar year | Destination-country VAT starts; **the Dutch KOR stops covering those sales**; need OSS or EU-KOR. Only reverts after a full calendar year under. |
| **€20,000** | Total Dutch turnover | KOR ends **immediately, at the transaction that crosses it** — not at year end. Deregister at once, charge 21% from that moment, quarterly returns resume, input VAT deductible again. |
| **€100,000** | EU-wide turnover | Ceiling for EU-KOR, the cross-border exemption ('EX' registration, from 2025) |

At €3/month that is roughly **555 subscribers** to €20,000, and **~280 non-Dutch
EU subscribers** to €10,000. Revenue does not grow smoothly through the €20,000
point: per-subscriber net drops €2.69 → €2.15 the moment it is crossed. Plan a
price rise or a deliberate absorption before getting near it.

### Entity: eenmanszaak, and specifically not the shared BV

The BV is co-owned and does something else entirely. Putting this in it gives a
cofounder an interest in an unrelated asset, muddies that company's books,
probably needs their consent, and points any liability here at the entity holding
the real business. All downside.

A dedicated BV costs €500–1,500 to set up plus €1,000–2,000/year in accounting —
most of the margin at this scale, to insure against risks that are mostly small.
The realistic tail risk is a **data breach** (Google emails plus which videos
people summarised), and there neither entity form helps much: under GDPR you are
the controller personally either way. So: eenmanszaak, keep collecting as little
as it already does, consider a cheap bedrijfsaansprakelijkheidsverzekering, and
revisit the BV around the same revenue where the €20,000 KOR cliff lands — one
conversation, not two.

**Not legal or tax advice, and not checked against the actual situation** — the
KVK details, marital property regime and the reverse-charge question all need the
accountant who already does the BV. This section is the shape, not the ruling.

### Decisions, settled

| # | Decision | Consequence for the build |
|---|---|---|
| 1 | Stripe, not an MoR | Webhook + HMAC verification, no SDK needed |
| 2 | No VAT charged (KOR) | No Stripe Tax, no OSS, no per-country pricing |
| 3 | Free length cap deferred | Build works without it; see below |
| 4 | **No** grandfathering of existing users | No third plan value |
| 5 | Access runs **to period end** | Guard reads `current_period_end`, not `plan` alone |
| 6 | Erasure **blocked** while subscribed | `DELETE /v1/me` returns 409 with a portal link |
| 7 | **EUR only**, one price | One Stripe Price |
| 8 | **€3/month flat**, every country | — |
| 9 | Full **14-day** withdrawal honoured | No waiver checkbox at checkout; simplest to build |

On (6): the alternative — letting erasure leave a live subscription — bills
someone who has no account left to cancel from, whose only lever is a chargeback
at ~€15 a time against your Stripe account health. Note also that once money is
involved "delete my data" cannot mean everything: Dutch law requires billing
records be kept ~7 years, which the privacy policy has to say.

### Build plan, ~14–18h

| # | Step | Est. |
|---|---|---|
| 1 | Stripe account, product, €3 Price, Payment Link with `client_reference_id`, portal config *(no code)* | 1–2h |
| 2 | Schema: `stripe_customer_id`, `subscription_status`, `current_period_end` on `users`; `processed_events` for idempotency | 30m |
| 3 | **Webhook endpoint** — the real work. A raw-body variant of `readBody` (it already does `Buffer.concat`, just skip the `JSON.parse`), HMAC-SHA256 verification via `node:crypto` (~30 lines), idempotency insert, four event types. Must bypass the CORS gate, the auth gate and the rate limiter. | 2–3h |
| 4 | `effectivePlan(user, now)` — `'plus'` only while `now < current_period_end`. `maxVideoSecondsFor` already handles anything non-free, so one function and two call sites. | 45m |
| 5 | Erasure block on `DELETE /v1/me` | 30m |
| 6 | Extension: options page plan/upgrade/manage, and the length-refusal message in the panel becomes the upsell — that is the surface that actually converts | 1.5–2h |
| 7 | `POST /v1/billing/portal` → Stripe API via `fetch`, still no dependency | 45m |
| 8 | Tests to the existing bar (the suite is 832 lines, 135 assertions): signed fixtures, replay, bad signature, expiry boundary | 2–3h |
| 9 | Legal + copy: trader identification (legal name, address, KVK, email — required by EU consumer law), subscription terms, 14-day withdrawal, Stripe as processor, billing retention, website pricing | 2h |
| 10 | End-to-end in test mode with Stripe test clocks: wall → upgrade → works → cancel → still works → expires | 1.5–2h |
| 11 | Deploy, register the webhook against Railway, one real €3 charge and refund | 1h |

**The short path is steps 1–4, 6 (options page only) and 11 — 4–6 hours** — and
it genuinely takes money. It defers tests, the panel upsell, the portal endpoint
(use Stripe's no-code portal link) and the legal copy. Defensible for friends;
not for strangers, who need step 9 first. **Do not defer webhook idempotency even
in the short version** — Stripe sends duplicates by design, and the Railway
redeploy overlap documented above means two instances can process one event.

Two sequencing facts. **The paywall sells nothing until the free cap moves:**
`freeMaxVideoSeconds` is 90 minutes and `plusMaxVideoSeconds` 240, and almost no
video sits between them, so all of this will build, test and convert nobody until
decision 3 is made. And **step 6 touches the extension**, so it batches into a
store version rather than going up alone; every server step is independent of the
store queue.

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
2. **Video length cap** (`YTS_FREE_MAX_VIDEO_MINUTES`).
3. **Weekly quota** (`YTS_WEEKLY_QUOTA_MINUTES`) — skipped for
   `plan = 'unlimited'`.
4. **Existing summary?** → serve it, bill the reader, never call Gemini.
5. **Daily spend cap** (`YTS_DAILY_SPEND_CAP_USD`, rolling 24h) — read fresh from Postgres immediately
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
2. **Chrome Web Store**: submitted 12 Aug 2026, unlisted, **pending review**.
   Expect days rather than hours — a host permission forces a manual in-depth
   review. v0.5.3 is what is in the queue; v0.5.4 (the "what gets stored"
   disclosure) is built and waiting to go up as the first update, so batch
   anything else into it. Do not upload over a submission that is in review;
   it restarts the queue. **When approved:** install from the store and re-run
   the golden path, then swap the website CTA from the sideload download to
   the store link (one marked spot in `docs/index.html`).
3. ~~Server-side duration lookup.~~ **Done** — `server/src/youtube.js`. The one
   thing left is operational: create the API key. In the same Google Cloud
   project as the Gemini key, enable **YouTube Data API v3**, make a key
   restricted to that one API, and set `YOUTUBE_API_KEY` on Railway. **Until
   that variable is set the server still believes the client**, and says so in
   its first log lines. **Set it before strangers get the link.**
4. ~~`YTS_ALLOWED_ORIGINS` must not be `*`~~ **Done** — set to both extension
   origins, verified: a random origin still gets 403.
5. ~~Store link placeholder in `docs/index.html`~~ **Done** — the site now
   hosts the sideload zip and its install steps, so sharing it is one URL.
   Swap the CTA to the store link once approved.
6. **Payments and the paid tier — last, after friends have used it.** Every
   decision is now made and written down (see "Payments"): Stripe, no VAT under
   the KOR, eenmanszaak, €3/month EUR flat, access to period end, erasure blocked
   while subscribed. Nothing is built; the plan is ~14–18h, or 4–6h for a version
   that takes money without tests or legal copy. Two non-code items first: apply
   for the KOR, and put the entity and reverse-charge questions to the
   accountant. The free length threshold is still the one product decision open,
   and until it moves the paywall converts nobody.

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
