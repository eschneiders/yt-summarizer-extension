import { config } from './config.js';
import { getSetting, setSetting, readDigestStats, spendSince } from './db.js';
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

const usd = (n) => `$${n.toFixed(2)}`;

// Exported and kept free of any I/O so it can be tested against fixed input
// rather than against whatever happens to be in the database right now.
export function formatDigest(day, stats) {
  const lines = [
    `YTS daily report — ${day} (UTC)`,
    `Spend: ${usd(stats.spend_usd)} across ${stats.generations} generation${stats.generations === 1 ? '' : 's'}`,
    `New sign-ups: ${stats.new_users}`,
    `Summaries opened: ${stats.reads} by ${stats.active_readers} ${stats.active_readers === 1 ? 'person' : 'people'}`,
  ];
  return lines.join('\n');
}

function hadActivity(stats) {
  return stats.generations > 0 || stats.new_users > 0 || stats.reads > 0;
}

// Runs on a poll (see index.js), so this is idempotent and cheap to call
// repeatedly: it only ever sends for a day it has not already sent, and it
// only considers a day sent once `notify` has returned without throwing.
export async function maybeSendDailyDigest(now = Date.now()) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  // Report on the day that just finished, not on today-so-far - a partial
  // day's numbers read as wrong even when they are accurate, because nobody
  // asking "how was yesterday" means "as of an arbitrary moment this morning".
  const yesterday = utcDay(now - DAY_MS);
  const lastSent = await getSetting('digest_last_day');
  if (lastSent === yesterday.key) return;

  const stats = await readDigestStats(yesterday.startMs, yesterday.endMs);
  // No activity means nothing to report and nobody to bother - explicitly
  // asked for, and it is also just the right default for a cost report.
  if (!hadActivity(stats)) {
    await setSetting('digest_last_day', yesterday.key);
    return;
  }

  await notify(formatDigest(yesterday.key, stats));
  await setSetting('digest_last_day', yesterday.key);
}

// ---------- spend alerts ----------

// Distinct from the digest: this is about now, not about yesterday, and it
// exists to catch a runaway before the day is over rather than to summarise
// afterwards. It rides the same rolling 24h window assertUnderSpendCap uses,
// so "the cap" means the same thing in an alert as it does in a refusal.
const LEVELS = [
  { level: 1, fraction: 0.5, describe: (spent, cap) =>
      `YTS spend is at ${usd(spent)} of the ${usd(cap)} daily cap (50%+) in the last 24h.` },
  { level: 2, fraction: 1, describe: (spent, cap) =>
      `YTS has hit its ${usd(cap)} daily spend cap (${usd(spent)} in the last 24h). ` +
      `New generations are being refused until this rolls off. Existing summaries still serve.` },
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

  if (currentLevel > stored) await notify(current.describe(spent, cap));
  // A drop is not announced - it is the return to normal, and the point of
  // this alert is to flag a problem, not to narrate every crossing.
  await setSetting('spend_alert_level', String(currentLevel));
}
