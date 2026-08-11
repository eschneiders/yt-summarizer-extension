# YouTube Feed Summariser — context for a fresh session

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
options/              service URL, sign in/out, quota, delete my data
icons/                generated PNGs (16/32/48/128)
docs/                 the public website — GitHub Pages serves this folder
server/               Node, one dependency (`pg`)
  src/index.js        node:http router, CORS, SSE, auth gate, rate limit
  src/summarise.js    THE ONLY PATH THAT SPENDS MONEY — all guards live here
  src/gemini.js       Gemini call + prompt + cost estimation
  src/auth.js         Google code exchange, sessions, salted user hashing
  src/db.js           all SQL
  src/schema.sql      applied idempotently at boot
  test/api.test.mjs   71 assertions against a live server
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

## Surfaces (4, all live)

| Surface | Path | Panel style |
|---|---|---|
| home | `/` | inline accordion, full grid width |
| subscriptions | `/feed/subscriptions` | inline accordion |
| watch | `/watch` | inline, under player above description |
| related | `/watch` (sidebar rail) | popup, closes on outside click |

`/watch` runs **two surfaces at once**, so buttons carry `data-yts-surface` and
the click handler resolves the surface from that stamp, not from the pathname.

---

## Running it

**Server** (needs Postgres):
```bash
createdb yts_test && cd server && npm install && npm start
cd server && npm test      # 71 assertions, in another terminal
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

Railway environment: `DATABASE_URL`, `YTS_DATABASE_SSL=true`, `GEMINI_API_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YTS_DAILY_SPEND_CAP_USD=2`,
`YTS_WEEKLY_QUOTA_MINUTES=400`, `YTS_ALLOWED_ORIGINS=chrome-extension://ejijl…`,
`PORT=8787`.

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

## Guards on the money path, outermost first

In `server/src/summarise.js`, in this order and for this reason:

1. **Unknown/zero duration** → refuse. Can't be metered, must not be served.
2. **Video length cap** (60 min).
3. **Weekly quota** — skipped for `plan = 'unlimited'`.
4. **Existing summary?** → serve it, bill the reader, never call Gemini.
5. **Daily spend cap** ($2, rolling 24h) — read fresh from Postgres immediately
   before every call, never cached. It's the thing standing between a bug and a
   bill, and it has to hold precisely when something has gone wrong.
6. Service key present, one generation in flight per user.

## Deliberately NOT there

- No user-facing options beyond service URL and sign-in. No model picker.
- No local caching in the extension.
- No archive page.
- `m.youtube.com` is unsupported by design.

---

## Still to do before this is public

1. **Daily cost report** — Telegram bot (needs a BotFather token) or email:
   spend, calls, new users. Not built.
2. **Chrome Web Store**: $5 fee, unlisted, data disclosures matching the privacy
   policy. Not started. After publishing, check the assigned extension ID — if
   it differs from the pinned one, add the new `chromiumapp.org` redirect URI.
3. **Server-side duration lookup.** The client currently asserts
   `durationSeconds` and the allowance is metered against it. Fine while the
   only client is ours; a hand-written one could claim a 3-hour video is 60
   seconds. Fix: YouTube Data API v3 `videos.list?part=contentDetails`, 1 unit
   per call against a 10,000/day free quota, cached on the `videos` row so each
   video is looked up once ever. **Do this before strangers get the link.**
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
