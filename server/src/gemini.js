// Gemini call. We hand the model the YouTube URL directly rather than a
// transcript - YouTube's /api/timedtext endpoint now answers 200 with a
// zero-length body unless the request carries a proof-of-origin token, so
// scraping captions from the feed is not viable.
//
// The request is deliberately minimal: just the video, no instruction text and
// no response schema. Side-by-side comparison against the Gemini web app showed
// our prompt + JSON schema flattened the output - specifics like exact prices
// and names were being compressed away to fit the schema's fields. Free-form
// markdown is what the web app produces, and it read considerably better, so
// the rendering layer parses markdown instead of dictating a shape.
//
// The one deliberate departure from web-app defaults is resolution:"low",
// which is a pure cost lever (66 vs 258 tokens per frame).

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Flash only, deliberately not configurable. Flash-Lite is the cheapest
// video-capable tier: $0.30/$2.50 per Mtok against $1.50/$7.50 for 3.6-flash.
export const MODEL = 'gemini-3.5-flash-lite';

// USD per 1M tokens, paid tier - which is now the real bill, not a hypothetical
// one: the server holds the key and pays for every call. Hardcoded, so they go
// stale silently if Google changes them - check
// ai.google.dev/gemini-api/docs/pricing.
//
// These rates overstate observed spend by roughly 4x. Measured across 120
// videos averaging ~20 minutes, actual cost was $0.26, or about 92 minutes of
// video per US cent. The spend cap uses these figures anyway: a cap that errs
// towards stopping early is the correct direction to be wrong in.
const PRICE_PER_MTOK_INPUT = 0.3;
const PRICE_PER_MTOK_OUTPUT = 2.5;

// Input tokens observed for an 11:18 video on gemini-3.6-flash at default
// media resolution. Logged against every call so a claimed saving can be
// checked rather than assumed.
const BASELINE_TOKENS_PER_SECOND = 62045 / 678;

// The prompt. Arrived at over nine rounds of A/B testing against the Gemini
// web app's output, each candidate run twice because run-to-run variance
// turned out to exceed the difference between prompts.
//
// Sending no instruction at all does NOT reproduce the web app: pasting a link
// there wraps it in the app's own system prompt, which is where its bullets,
// bold labels and timestamps come from. A bare call returns a short prose blob
// with no timestamps, which also breaks the timestamp chips. A rigid JSON
// response schema was tried too and was worse - it flattened out the specifics
// (exact figures, names, the video's own examples) to fit its fields.
//
// The final round pitted this against a longer version that said the same
// things across more sentences - brevity was stated three separate times, the
// section shape twice, each added by a different round without removing what
// it superseded. This shorter one won on every measure: 33% vs 61% word-count
// spread run to run, 3 sections every time vs drifting to 6, and - the telling
// one - it obeyed its own two-timestamps-per-overview cap 3 runs out of 4
// against the longer version's 1 out of 4, which once put ten timestamps in a
// single paragraph. More restatement of a rule made it less likely to be
// followed, not more.
const SYSTEM_INSTRUCTION = `Summarise expertly this video for someone who wants its content without
watching it. You are given the video itself - watch and listen to it; there is
no transcript, so derive everything, including timestamps, from the video.

Open with an executive summary: a single paragraph under the heading
"## Overview" giving what the video establishes and what claim, question or
common belief it is responding to - state this directly, not that the video
"examines", "addresses" or "responds to" something. Then group the key points
thematically under numbered headings ("## 1. ", "## 2. "...) - by topic or
argument, not in the order things happen to be said. Aim for three to five
sections, rarely more than six.

WRITE EVERY HEADING SO THAT IT BRIEFLY STATES THE POINT OF ITS SECTION, NOT
MERELY THE TOPIC THAT SECTION COVERS. A READER MUST BE ABLE TO GET THE
SUBSTANCE OF A SECTION FROM ITS HEADING ALONE. THIS IS THE MOST IMPORTANT
FORMATTING RULE ON THIS LIST - DO NOT SKIP IT.

Write each point as an unnumbered "- " bullet (one level of indented
sub-bullets allowed), beginning with a short bold label and a colon, followed
by one to two sentences of substance. Use only "## " headings, "- " bullets,
**bold** and *italic* - no tables, no images, no horizontal rules, no numbers
on the bullets themselves.

Every sentence must earn its place: prefer the shorter, more direct phrasing
wherever nothing of substance is lost.

Include timestamps throughout, not confined to one at the end of each bullet:
place a timestamp, as bare text like 1:28 (or 1:06:29 for videos over an
hour), right after the specific claim or clause it supports. Never wrap a
timestamp in brackets, parentheses or a link.

NEVER MORE THAN TWO TIMESTAMPS IN ANY SINGLE BULLET, AND NEVER MORE THAN TWO IN
THE OVERVIEW PARAGRAPH - THIS IS A HARD LIMIT, NOT A TARGET.

Return markdown only. No preamble and no sign-off: never open with "Sure" or
"Here is a summary", never restate the title as a sentence, and never end with
the video URL, the channel name, view counts, or an offer to help further.
Write in English even when the video is in another language.

BE BRIEF.`;

function buildRequestBody(videoUrl) {
  return {
    model: MODEL,
    // Instructions go in the system slot rather than the user turn: it is a
    // real top-level field on this endpoint, and it leaves `input` as just the
    // video - the same shape as pasting a link into the web app, which carries
    // its own system prompt.
    system_instruction: SYSTEM_INSTRUCTION,
    input: [
      // resolution "low" tokenises frames at 66 instead of 258. The API
      // reference puts resolution on the video block itself, but shows no
      // request example, so a wrong field name would most likely be ignored
      // silently. The tokens/sec figure logged below is what confirms it.
      { type: 'video', uri: videoUrl, resolution: 'low' },
    ],
    // No generation_config: thinking is left at the model default, matching
    // the web app. thinking_level:"minimal" measurably cost us detail.
    // Note: this endpoint does not accept `temperature` at all - not at top
    // level and not in generation_config - so there is no knob for it here.
  };
}

// The main-point prompt. Deliberately short: the nine rounds that produced the
// summary prompt found that restating a rule made it LESS likely to be
// followed, so each thing here is said exactly once.
//
// The last paragraph is the one that earns its place. Plenty of videos - news
// roundups, tip lists, walkthroughs - are not arguing anything, and without an
// explicit way out the model will manufacture a through-line and state it with
// the same confidence as a real one. An honest "this isn't that kind of video"
// is the more useful answer, and it is the difference between this being a
// thinking aid and a machine for making lists sound like arguments.
const MAIN_POINT_INSTRUCTION = `You are given a summary of a video. State the single main point the video is
arguing for - the claim it wants the viewer to leave with, not a description of
what it covers.

Two or three sentences. No heading, no bullets, no preamble. State the claim
itself rather than writing "the video argues that".

If the video is not arguing one point - a news roundup, a list of tips, a
walkthrough, a review of several things - say that instead, in one sentence.
Do not invent a through-line that is not there.`;

// Text in, text out. The `input` shape here mirrors the video block in
// buildRequestBody - same endpoint, same system_instruction slot, a text part
// instead of a video one. The API reference documents the part types by name
// without a request example, which is the same situation that made
// resolution:"low" worth verifying by its token count; here the check is
// cheaper, because a wrong shape produces an HTTP error rather than a silently
// ignored field.
function buildMainPointBody(summaryMarkdown) {
  return {
    model: MODEL,
    system_instruction: MAIN_POINT_INSTRUCTION,
    input: [{ type: 'text', text: summaryMarkdown }],
  };
}

/**
 * Reads a stored summary and returns the video's central claim.
 *
 * No streaming: this is two or three sentences, so the machinery would buy a
 * perceived-latency win worth less than the extra failure mode. Costs a
 * fraction of the summary it derives from - a few hundred tokens of text
 * against minutes of ingested video - and the gap widens the longer the video.
 */
export async function extractMainPoint({ apiKey, summaryMarkdown }) {
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(buildMainPointBody(summaryMarkdown)),
  });

  if (!res.ok) throw await readError(res);

  const payload = JSON.parse(await res.text());
  if (payload.status && payload.status !== 'completed') {
    console.warn('[yts:api] main-point interaction status was "%s"', payload.status);
  }

  let text = payload.output_text || '';
  if (!text) {
    for (const step of payload.steps || []) {
      if (step.type !== 'model_output') continue;
      text += (step.content || [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('');
    }
  }
  if (!text.trim()) throw new Error('Gemini returned no main point');

  const cost = estimateCost(payload.usage);
  // No durationSeconds: there is no video in this call, so the tokens-per-second
  // baseline check logUsage does would be meaningless here.
  logUsage(cost, ((Date.now() - started) / 1000).toFixed(1), 0);
  return { markdown: text.trim(), usage: payload.usage || null, cost, model: MODEL };
}

function estimateCost(usage) {
  if (!usage) return null;
  const inputTokens = usage.total_input_tokens || 0;
  const outputTokens = usage.total_output_tokens || 0;
  const thoughtTokens = usage.total_thought_tokens || 0;

  // Thinking tokens are billed at the output rate and are counted SEPARATELY
  // from total_output_tokens - observed a response with 1,057 output against
  // 2,109 thinking, which rules out thoughts being a subset of output.
  const billableOutput = outputTokens + thoughtTokens;

  const inputUsd = (inputTokens / 1e6) * PRICE_PER_MTOK_INPUT;
  const outputUsd = (billableOutput / 1e6) * PRICE_PER_MTOK_OUTPUT;

  // Sanity check against the API's own total, so a wrong model of how these
  // fields compose shows up in the console instead of silently skewing cost.
  const reportedTotal = usage.total_tokens || 0;
  const derivedTotal = inputTokens + outputTokens + thoughtTokens;
  if (reportedTotal && Math.abs(reportedTotal - derivedTotal) > 1) {
    console.warn(
      '[yts:api] token math does not reconcile: API total_tokens=%d but in+out+thoughts=%d. Cost estimate may be off.',
      reportedTotal,
      derivedTotal
    );
  }

  return {
    inputTokens,
    outputTokens,
    thoughtTokens,
    billableOutput,
    totalTokens: reportedTotal || derivedTotal,
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
  };
}

function logUsage(cost, elapsed, durationSeconds) {
  if (!cost) {
    console.warn('[yts:api] no usage returned, cannot estimate cost');
    return;
  }
  console.log(`[yts:api] ${MODEL} · ${elapsed}s · $${cost.totalUsd.toFixed(5)}`);
  console.log(
    '[yts:api] tokens: %d in ($%s) + %d out billable ($%s, = %d output + %d thinking) = %d total',
    cost.inputTokens,
    cost.inputUsd.toFixed(5),
    cost.billableOutput,
    cost.outputUsd.toFixed(5),
    cost.outputTokens,
    cost.thoughtTokens,
    cost.totalTokens
  );

  // Tokens per second of video is the only honest way to tell whether the
  // resolution hint landed - raw counts vary with video length.
  if (durationSeconds) {
    const perSecond = cost.inputTokens / durationSeconds;
    const delta = (1 - perSecond / BASELINE_TOKENS_PER_SECOND) * 100;
    console.log(
      '[yts:api] %s input tok/sec of video (baseline %s) → %s%s%% vs baseline',
      perSecond.toFixed(1),
      BASELINE_TOKENS_PER_SECOND.toFixed(1),
      delta >= 0 ? '-' : '+',
      Math.abs(delta).toFixed(0)
    );
    if (Math.abs(delta) < 5) {
      console.warn(
        '[yts:api] input tokens are within 5%% of baseline - resolution:"low" is probably being ignored.'
      );
    }
  }
}

async function readError(res) {
  const raw = await res.text();
  let detail = raw.slice(0, 400);
  try {
    const parsed = JSON.parse(raw);
    if (parsed.error && parsed.error.message) detail = parsed.error.message;
  } catch (e) {
    /* keep raw */
  }
  return new Error(`Gemini HTTP ${res.status}: ${detail}`);
}

// The SSE event shapes for this endpoint are documented only by name
// (StepDelta / TextDelta / ...), without a concrete payload example, so pull
// text out of whatever shape actually arrives rather than assuming one.
function extractDeltaText(evt) {
  if (!evt || typeof evt !== 'object') return '';
  if (typeof evt.text === 'string' && evt.type !== 'error') return evt.text;
  if (evt.delta) {
    if (typeof evt.delta === 'string') return evt.delta;
    if (typeof evt.delta.text === 'string') return evt.delta.text;
  }
  let out = '';
  for (const key of ['content', 'deltas', 'parts']) {
    const list = evt[key];
    if (Array.isArray(list)) {
      list.forEach((item) => {
        if (item && typeof item.text === 'string') out += item.text;
      });
    }
  }
  if (evt.step) out += extractDeltaText(evt.step);
  return out;
}

function extractUsage(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.usage) return evt.usage;
  if (evt.interaction && evt.interaction.usage) return evt.interaction.usage;
  return null;
}

// Streams the response so the panel can show markdown as it arrives. Throws if
// streaming produces no usable text, so the caller can fall back.
export async function summarizeYouTubeVideoStreaming({
  apiKey,
  videoUrl,
  durationSeconds,
  onDelta,
}) {
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ ...buildRequestBody(videoUrl), stream: true }),
  });

  if (!res.ok) throw await readError(res);
  if (!res.body) throw new Error('streaming requested but no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let loggedShape = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let evt;
      try {
        evt = JSON.parse(payload);
      } catch (e) {
        continue;
      }

      if (!loggedShape) {
        loggedShape = true;
        console.log('[yts:api] first SSE event shape:', Object.keys(evt), evt.type || '(no type)');
      }

      usage = extractUsage(evt) || usage;
      const delta = extractDeltaText(evt);
      if (delta) {
        text += delta;
        if (onDelta) onDelta(text);
      }
    }
  }

  if (!text.trim()) throw new Error('stream produced no text');

  const cost = estimateCost(usage);
  logUsage(cost, ((Date.now() - started) / 1000).toFixed(1), durationSeconds);
  return { markdown: text, usage, cost, model: MODEL };
}

export async function summarizeYouTubeVideo({ apiKey, videoUrl, durationSeconds }) {
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(buildRequestBody(videoUrl)),
  });

  if (!res.ok) throw await readError(res);

  const payload = JSON.parse(await res.text());
  if (payload.status && payload.status !== 'completed') {
    console.warn('[yts:api] interaction status was "%s"', payload.status);
  }

  let text = payload.output_text || '';
  if (!text) {
    for (const step of payload.steps || []) {
      if (step.type !== 'model_output') continue;
      text += (step.content || [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('');
    }
  }
  if (!text.trim()) throw new Error('Gemini returned no output text');

  const cost = estimateCost(payload.usage);
  logUsage(cost, ((Date.now() - started) / 1000).toFixed(1), durationSeconds);
  return { markdown: text, usage: payload.usage || null, cost, model: MODEL };
}
