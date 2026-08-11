import { config } from './config.js';
import { getSetting, claimSetting, readDigestStats, spendSince } from './db.js';
import { notify } from './notify.js';

const DAY_MS = 86400000;

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
export function formatDigest(day, stats, cap = config.dailySpendCapUsd) {
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
  return lines.join('\n');
}

function hadActivity(stats) {
  return stats.generations > 0 || stats.new_users > 0 || stats.reads > 0;
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

  const stats = await readDigestStats(yesterday.startMs, yesterday.endMs);
  // No activity means nothing to report and nobody to bother - explicitly
  // asked for, and it is also just the right default for a cost report.
  if (!hadActivity(stats)) return;

  await notify(formatDigest(yesterday.key, stats));
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
