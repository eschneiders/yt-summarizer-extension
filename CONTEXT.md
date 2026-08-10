# YouTube Feed Summariser — context for a fresh session

Paste this at the start of a new chat.

---

I'm working on a Chrome extension (Manifest V3) at `~/yt-summarizer-extension`.
It injects a "Summarise" button onto YouTube video cards; clicking it sends the
video to Gemini and renders a summary panel inline. It works end to end. I want
to tackle bugs now — **not** re-architect it or re-tune the prompt.

## How to run it

Unpacked dev extension, tested manually in my own Chrome:

1. `chrome://extensions` → Developer mode on → Load unpacked → `~/yt-summarizer-extension`
2. Extension options (Details → Extension options) → paste Gemini API key → Save
3. Go to youtube.com, click a Summarise pill, watch the console for `[yts]` logs

**After any code change: reload the extension at `chrome://extensions` AND hard-reload
the YouTube tab (Cmd+Shift+R).** Extension reload alone leaves orphaned content scripts.

Service-worker logs (`[yts:sw]`) go to a *separate* DevTools window — open it from the
"service worker" link on the extension's card. Page logs (`[yts]`) are in the normal console.

You cannot test the extension yourself — you have no way to load an unpacked
extension. I run those and paste results back. Give me exact things to look for.

The **server** you can test: `cd server && npm start`, then `npm test` in another
terminal. 36 assertions, no dependencies, safe to re-run.

## Architecture

```
manifest.json              MV3, ES-module service worker, storage perm
background/
  gemini.js       (334)    Gemini call + prompt + cost estimation
  service-worker.js (395)  message/port router, cache, duration + quota guards
  api.js           (83)    client for server/ — returns null when absent/down
content/
  surfaces.js     (127)    per-surface config — ADD A NEW SURFACE HERE, one entry
  button.js       (159)    button create/sync, videoId stamping, skip-hiding
  panel.js        (606)    markdown renderer + panel placement/lifecycle
  content.js      (435)    entry point, SPA nav, MutationObserver, click handler
  content.css     (~470)   all classes yts- prefixed
options/                   API key + service URL + quota readout
server/                    optional shared-counter service, zero dependencies
  src/config.js    (33)    thresholds and limits, all env-overridable
  src/db.js       (223)    SQLite schema + the vote/quota/view operations
  src/index.js    (237)    node:http router, CORS, rate limit, identity
```

Content scripts load in manifest order and share one `window.__ytSummarizer` namespace.

**The server is optional and the extension must keep working without it.** Every
call in `api.js` returns `null` when no service URL is saved, when the service is
unreachable, or during the 30s cool-down after a failure. Callers treat `null` as
"carry on local-only": local cache, local votes, no counter, no weekly limit. Do
not add a code path that requires the service to be up.

## Surfaces (4, all live)

| Surface | Path | Panel style |
|---|---|---|
| home | `/` | inline accordion, full grid width |
| subscriptions | `/feed/subscriptions` | inline accordion |
| watch | `/watch` | inline, under player above description |
| related | `/watch` (sidebar rail) | popup, `position:absolute` in page coords |

`/watch` runs **two surfaces at once**, so buttons carry `data-yts-surface` and the
click handler resolves the surface from that stamp, not from the pathname.

## Gemini API facts — hard-won, please don't re-derive

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  (NOT `models/{model}:generateContent` — different request/response shape entirely)
- Model in the **body**, not the URL. Auth header `x-goog-api-key`.
- Model: `gemini-3.5-flash-lite` — cheapest video-capable tier
- Input is `input: [{type:'video', uri, resolution:'low'}]` — no text part; instructions
  go in the top-level `system_instruction` field
- Output text is at `output_text` (fallback: walk `steps[].content[].text`)
- Usage at `usage.{total_input_tokens,total_output_tokens,total_thought_tokens}` —
  **thinking tokens are counted separately from output**, not a subset
- **`temperature` / `top_p` / `top_k` do not exist on this endpoint.** Only `seed` and
  `thinking_level` in `generation_config`. Confirmed twice in the docs.
- Streaming: `stream: true`, SSE. Event payload shapes are NOT documented with concrete
  examples, so `extractDeltaText()` is defensive and logs the first event's keys.
  There's a blocking fallback if streaming fails.
- YouTube's `/api/timedtext` is dead for this purpose — returns HTTP 200 with a
  **zero-length body** without a proof-of-origin token. Verified empirically. Don't
  suggest transcript scraping; that's why we send the URL to Gemini instead.

## Decisions that took real work — please don't undo casually

- **Free-form markdown, no JSON response schema.** A schema was tried and it flattened
  the output — specifics like exact figures and names got compressed away to fit fields.
  `panel.js` parses markdown and builds DOM with `textContent` (never `innerHTML`).
- **The prompt took 9 rounds of A/B testing**, each candidate run twice because
  run-to-run variance exceeded the difference between prompts. Notable finding:
  *restating a rule made it LESS likely to be followed.* A longer prompt that stated
  brevity three times obeyed its own timestamp cap 1 run in 4; the deduplicated version
  obeyed it 3 in 4. **Don't "improve" the prompt by adding emphasis or restating rules.**
  The reasoning is commented above `SYSTEM_INSTRUCTION` in `gemini.js`.
- **Panel is in-flow (accordion), not an overlay**, on grid surfaces. This was chosen
  deliberately over a floating overlay. `panel.syncPlacement()` re-validates it on every
  observer pass because YouTube's renderer can move or drop a foreign child.
- **Dedupe by videoId, never by "does a button exist".** The grid virtualises and
  recycles card nodes; buttons are stamped with `data-yts-video-id` and re-checked.
- CSS uses `max-height` + `overflow:hidden` for the collapse animation, so content past
  `max-height` is **silently clipped with no scrollbar**. Bit us once already.
- **No Re-summarise button, and don't add one back.** A summary is written once and
  reused by everyone, so letting each reader pay to redo it defeats the economics.
  The replacement is thumbs up/down: when downvotes pass the server's threshold the
  video's `revision` is bumped, which retires every cached copy, and the next open
  re-runs it automatically. The `refresh: true` plumbing still exists and is used by
  that path — it just has no button.
- **One rewrite per video, capped server-side** (`YTS_MAX_REVISION`, default 2). If
  the rewrite gets downvoted too, votes come back `exhausted: true` and nothing more
  happens. A video the model keeps failing on is not fixed by a third attempt.
- **"Summarised" means "you paid for this", not "a summary exists".** Driven by the
  server's `youViewed`, mirrored locally in `mine:<id>` keys for offline. A cached
  summary someone else generated still bills the reader — serving it is free, reading
  it is not. Don't wire the label back to the presence of a `sum:` key.
- **The watch-page panel has no Watch/Later/Skip.** You are already watching it,
  "Later" would queue the page you are on, and there is no feed card to hide. Those
  three are feed-surface only; the thumbnail-level panel keeps them.
- **Feed sweeps are throttled with a maxWait, not debounced.** A YouTube feed mutates
  continuously while scrolling, so a pure trailing debounce is starved for exactly as
  long as the user keeps scrolling — which is why buttons never appeared on cards
  loaded further down. See `scheduler()` in `content.js`. Don't simplify it back.

## Cost

Free tier bills nothing; the cap is **8 hours of YouTube video input per day**.
The in-code cost estimator (`estimateCost`) reports paid-tier rates and is **known to
overstate by ~4x** — actual spend was $0.10 where it estimated ~$0.39. Prices are
hardcoded constants at the top of `gemini.js`. Treat its output as indicative only.

`chrome.storage.local` keys:

| Key | Meaning |
|---|---|
| `sum:<id>` | Cached summary — markdown, model, and the server `revision` it was written against. Version 2, 300 newest kept. |
| `mine:<id>` | This user has been billed for this video. Offline mirror of the server's `youViewed`; survives cache pruning, because having paid is not undone by the summary being evicted. |
| `vote:<id>` | This user's thumb. Pruned with its summary. |
| `ytsUserId` | Anonymous UUID, minted on first use. |

Free-tier users get **300 minutes of video per ISO week**, metered server-side against
video length. Billing is per user per video: your own repeats are free, someone else's
summary is not. The per-video 60-minute cap still applies on top of the weekly one.

## Deliberately NOT there — don't add these

- **No user-facing options beyond the API key and the service URL.** No mode toggles,
  no model picker. One summary per video means one cache entry per video, which halves
  hosting cost. This is an economic decision, not an oversight.
- No accounts. The server identifies users by a UUID the extension mints on install and
  asserts in a header — enough for a per-browser quota and one vote per person, and
  forgeable by anyone who cares to. That is fine while each user pays for their own
  Gemini calls. **It stops being fine the moment the server pays for anything.**
- No archive page.
- `m.youtube.com` is unsupported by design — the content script registers there only to
  log a clear warning (its `ytm-*` DOM matches none of our selectors).

## Known / suspected issues — starting points for bug work

1. **`resolution:'low'` may be silently ignored.** The API reference puts `resolution`
   on the video block but shows no request example. `gemini.js` logs input tokens per
   second of video against a baseline and warns if it's within 5% of it — check the
   service-worker console for that line.
2. **Cost estimator ~4x too high** (see above) — needs recalibrating against real billing.
3. **`host_permissions` for `https://*.youtube.com/*` may now be unnecessary** — nothing
   fetches youtube.com since transcript scraping was dropped. Untested removal.
4. Related-rail and watch-page selectors have fallback lists but were only verified on
   one YouTube rollout; they log which selector matched.
5. Panel placement under fast scrolling on grid surfaces is the most likely fragile spot.
6. The grid sweep runs `document.querySelectorAll(cardSelector)` every 2s per surface
   plus on scroll. Cheap per card, but never profiled on a very long feed.
7. `HANDLERS.YTS_SUMMARIZE` in the service worker is unreachable — the content script
   only ever uses the streaming port. It has not been kept in step with the port path
   (no quota check, no stats, no revision). Delete it or wire it up; don't trust it.

## The bugs I actually want to fix

<!-- describe them here -->
