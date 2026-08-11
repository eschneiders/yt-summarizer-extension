import { config } from './config.js';
import {
  getSetting,
  claimSetting,
  readDigestStats,
  spendSince,
  recordIncident,
  readIncidents,
  dayKey,
} from './db.js';
import { notify } from './notify.js';

const DAY_MS = 86400000;

// ---------- critical failures ----------
//
// The rule, verbatim: one alert per day, and if more happen that day, stay
// quiet - one critical failure is already enough to mean "go and look". So the
// alert is claimed once per calendar day across every kind of failure, while
// the incidents table keeps counting everything in the background for the
// morning report.
//
// What belongs here is only what stops the service doing its job: it cannot
// generate, cannot look up a video, cannot sign anyone in, or the extension can
// no longer find YouTube's cards. A refused quota is not a failure, it is the
// system working.
export const CRITICAL = {
  GEMINI: 'gemini-call-failed',
  YOUTUBE: 'youtube-lookup-failed',
  AUTH: 'sign-in-exchange-failed',
  INTERNAL: 'unhandled-error',
  SELECTORS: 'youtube-layout-changed',
};

const HUMAN = {
  [CRITICAL.GEMINI]: 'Summaries cannot be generated — the Gemini call is failing.',
  [CRITICAL.YOUTUBE]: 'Video lengths cannot be looked up — new videos are being refused.',
  [CRITICAL.AUTH]: 'Nobody can sign in — Google is refusing the code exchange.',
  [CRITICAL.INTERNAL]: 'An unhandled error reached a request handler.',
  [CRITICAL.SELECTORS]:
    'The extension can no longer find video cards on YouTube — the layout has probably changed.',
};

/**
 * Records a critical failure, and alerts at most once a day.
 *
 * Never throws and never blocks the caller: this is called from catch blocks on
 * paths that are already going badly, and a reporting failure must not become
 * the thing that takes the request down with it.
 */
export async function reportCritical(kind, detail, now = Date.now()) {
  try {
    const count = await recordIncident(kind, detail, now);

    // Claim is per day, not per kind - the whole point is one nudge, not one
    // per category. A second kind of failure the same day still gets counted
    // and still shows up in the morning report.
    if (!config.telegramBotToken || !config.telegramChatId) return;
    if (!(await claimSetting('incident_alert_day', dayKey(now)))) return;

    await notify(
      `YTS problem — ${HUMAN[kind] || kind}\n\n` +
        `${String(detail).slice(0, 300)}\n\n` +
        `(${count === 1 ? 'first' : `${count}th`} today. Only one alert a day is sent; ` +
        `the morning report lists everything.)`
    );
  } catch (err) {
    console.error('[yts:api] could not record incident:', err.message);
  }
}

// UTC calendar day, as a key ("2026-08-11") and as the millisecond boundaries
// that key covers. A calendar day rather than a rolling window, because "the
// daily report" is a thing people read once, at a fixed time, about a period
// that has a name - "yesterday" - not about whichever 24 hours happen to have
// just elapsed.
function utcDay(ms) {
  const key = new Date(ms).toISOString().slice(0, 10);
  const startMs = Date.parse(`${key}T00:00:00.000Z`);
  return { key, startMs, endMs: startMs + DAY_MS };
}

// Cents are the natural unit here - a day's real spend is single-digit cents,
// and "$0.00" for three-tenths of a cent reads as "nothing happened".
const money = (usd) => (usd >= 1 ? `$${usd.toFixed(2)}` : `${(usd * 100).toFixed(1)}c`);

/**
 * What a given amount of video actually costs, at the measured rate.
 *
 * Deliberately not derived from token counts. See config.measuredMinutesPerCent
 * for why the two numbers exist and why they disagree.
 */
export function measuredUsd(durationSeconds, minutesPerCent = config.measuredMinutesPerCent) {
  if (!durationSeconds || !minutesPerCent) return 0;
  return durationSeconds / 60 / minutesPerCent / 100;
}

// Exported and kept free of any I/O so it can be tested against fixed input
// rather than against whatever happens to be in the database right now.
export function formatDigest(day, stats, cap = config.dailySpendCapUsd, incidents = []) {
  const minutes = Math.round(stats.duration_seconds / 60);
  const real = measuredUsd(stats.duration_seconds);

  const lines = [
    `YTS daily report — ${day} (UTC)`,
    `Spend: ~${money(real)} · ${stats.generations} generation${stats.generations === 1 ? '' : 's'} · ${minutes} min of video`,
    `New sign-ups: ${stats.new_users}`,
    `Opened: ${stats.reads} by ${stats.active_readers} ${stats.active_readers === 1 ? 'person' : 'people'}`,
  ];

  // The cap counts in list-price dollars, which run ~4x the real rate. Shown
  // only once it is worth knowing, so a quiet day stays a three-line message -
  // but shown before an alert can arrive out of nowhere quoting a number that
  // looks nothing like the spend on the line above.
  if (stats.capped_usd >= cap * 0.25) {
    lines.push(`Against the ${money(cap)} cap: ${money(stats.capped_usd)} (list prices, ~4x real)`);
  }

  // Everything that broke, with the last real message for each. This block is
  // meant to be copied straight into a coding agent, so it carries the detail
  // rather than a reassuring summary of it.
  if (incidents.length) {
    lines.push('', `⚠ ${incidents.length} problem${incidents.length === 1 ? '' : 's'}:`);
    for (const i of incidents) {
      lines.push(`• ${i.kind} ×${i.count} — ${i.sample}`);
    }
  }
  return lines.join('\n');
}

function hadActivity(stats, incidents) {
  // A day where nothing happened but something broke is very much worth a
  // message - arguably the most worth one.
  return stats.generations > 0 || stats.new_users > 0 || stats.reads > 0 || incidents.length > 0;
}

// Runs on a poll (see index.js), so this is idempotent and cheap to call
// repeatedly: it only ever sends for a day it has not already sent.
export async function maybeSendDailyDigest(now = Date.now()) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  // Report on the day that just finished, not on today-so-far - a partial
  // day's numbers read as wrong even when they are accurate, because nobody
  // asking "how was yesterday" means "as of an arbitrary moment this morning".
  const yesterday = utcDay(now - DAY_MS);

  // Claim the day before reading anything. Claiming first means a crash between
  // here and the send loses one report; claiming after would mean two instances
  // both send. A duplicate cost report is worse than a missed one - the whole
  // value of this message is that it is worth reading when it arrives.
  if (!(await claimSetting('digest_last_day', yesterday.key))) return;

  const [stats, incidents] = await Promise.all([
    readDigestStats(yesterday.startMs, yesterday.endMs),
    readIncidents(yesterday.key),
  ]);
  // No activity means nothing to report and nobody to bother - explicitly
  // asked for, and it is also just the right default for a cost report.
  if (!hadActivity(stats, incidents)) return;

  await notify(formatDigest(yesterday.key, stats, config.dailySpendCapUsd, incidents));
}

// ---------- spend alerts ----------

// Distinct from the digest: this is about now, not about yesterday, and it
// exists to catch a runaway before the day is over rather than to summarise
// afterwards. It rides the same rolling 24h window assertUnderSpendCap uses,
// so "the cap" means the same thing in an alert as it does in a refusal.
// Both messages carry the real figure alongside the cap figure, because the cap
// counts in list prices and the gap between the two is about 4x. An alert that
// said only "$1.00 of $2.00" would read as a genuine emergency when the actual
// money at stake is around 25 cents.
const LEVELS = [
  {
    level: 1,
    fraction: 0.5,
    describe: (spent, cap, real) =>
      `YTS spend is at ${money(spent)} of the ${money(cap)} daily cap (50%+) in the last 24h. ` +
      `Real spend at the measured rate is about ${money(real)}.`,
  },
  {
    level: 2,
    fraction: 1,
    describe: (spent, cap, real) =>
      `YTS has hit its ${money(cap)} daily spend cap (${money(spent)} in the last 24h, ` +
      `about ${money(real)} real). New generations are being refused until this rolls off. ` +
      `Existing summaries still serve.`,
  },
];

// Edge-triggered against a level stored in settings, not against a timestamp:
// re-alerts if spend climbs back up after dropping, but never repeats the same
// level on every poll while sitting above it - which is what a raw threshold
// check would do on a five-minute timer.
export async function maybeSendSpendAlert(now = Date.now()) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const cap = config.dailySpendCapUsd;
  const spent = await spendSince(now - DAY_MS);
  const current = LEVELS.filter((l) => spent >= cap * l.fraction).pop();
  const currentLevel = current ? current.level : 0;

  const stored = Number(await getSetting('spend_alert_level', '0'));
  if (currentLevel === stored) return;

  // Same claim-first reasoning as the digest: whichever instance wins the
  // write is the one that speaks. A drop is claimed but not announced - it is
  // the return to normal, and this alert exists to flag a problem rather than
  // to narrate every crossing.
  if (!(await claimSetting('spend_alert_level', String(currentLevel)))) return;

  if (currentLevel > stored) {
    const window = await readDigestStats(now - DAY_MS, now);
    await notify(current.describe(spent, cap, measuredUsd(window.duration_seconds)));
  }
}
