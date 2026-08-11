import { readFileSync } from 'node:fs';

import pg from 'pg';

import { config } from './config.js';

// Postgres rather than SQLite, for one reason that has nothing to do with
// scale: on a container host the filesystem is usually ephemeral, so a SQLite
// file quietly disappears on redeploy unless a volume is mounted exactly
// right. A managed database removes that whole category of accident.

// COUNT() and SUM() return int8, which node-postgres hands back as a string to
// avoid precision loss past 2^53. Every count in this schema is far below that,
// and a string where a number is expected is a silent bug (`"3" + 1 === "31"`),
// so int8 is parsed as a number here rather than cast at every call site.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => parseInt(value, 10));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.poolSize,
  // Hosted Postgres almost always terminates TLS with a certificate this
  // process has no way to chain to a local root. Verification is off for the
  // managed providers and irrelevant for a local socket.
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // An idle client dropped by the server. The pool replaces it; this exists so
  // the event does not reach the process as an unhandled error.
  console.error('[yts:api] idle postgres client error:', err.message);
});

export async function migrate() {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

// Runs fn inside a transaction on a single dedicated connection. Every
// multi-statement operation below goes through this - a read-then-write split
// across two pooled connections is not atomic no matter how it looks.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------- time ----------

const DAY_MS = 86400000;

// ISO-8601 week, UTC. Used as the quota bucket key: "2026-W33".
export function weekKey(now = Date.now()) {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayIndex = (new Date(midnight).getUTCDay() + 6) % 7; // Monday = 0
  // The Thursday of this week decides which year the week belongs to.
  const thursday = midnight + (3 - dayIndex) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Next Monday 00:00 UTC - when the quota bucket rolls over.
export function weekResetsAt(now = Date.now()) {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayIndex = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight + (7 - dayIndex) * DAY_MS;
}

// Calendar day, UTC: "2026-08-11". The bucket anonymous reads are counted in.
// A day rather than a week because the point is a taste, not an allowance.
export function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// ---------- operations ----------

// Every video referenced anywhere gets a row, so `revision` always has a home.
async function revisionOf(client, videoId) {
  await client.query(
    'INSERT INTO videos (video_id, first_seen_at) VALUES ($1, $2) ON CONFLICT (video_id) DO NOTHING',
    [videoId, Date.now()]
  );
  const { rows } = await client.query('SELECT revision FROM videos WHERE video_id = $1', [videoId]);
  return rows[0].revision;
}

// The cached length of a video, or 0 if it has never been looked up. See
// youtube.js - this is the read that keeps a 10,000/day API quota roomy.
export async function readVideoDuration(videoId) {
  const { rows } = await pool.query(
    'SELECT duration_seconds FROM videos WHERE video_id = $1',
    [videoId]
  );
  return rows.length ? rows[0].duration_seconds || 0 : 0;
}

// Written once per video and never revised: a published video's length does not
// change, and COALESCE means a concurrent second lookup cannot overwrite the
// first with anything different anyway.
export async function writeVideoDuration(videoId, seconds) {
  const value = Math.max(0, Math.round(seconds) || 0);
  if (value <= 0) return;
  await pool.query(
    `INSERT INTO videos (video_id, first_seen_at, duration_seconds) VALUES ($1, $2, $3)
     ON CONFLICT (video_id)
     DO UPDATE SET duration_seconds = COALESCE(videos.duration_seconds, EXCLUDED.duration_seconds)`,
    [videoId, Date.now(), value]
  );
}

export async function readStats(videoId, userId) {
  return transaction(async (client) => {
    const revision = await revisionOf(client, videoId);
    const { rows } = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM views WHERE video_id = $1)                    AS summarised_by,
         (SELECT COUNT(*) FROM views WHERE video_id = $1 AND user_id <> $2)  AS others,
         (SELECT COUNT(*) FROM views WHERE video_id = $1 AND user_id  = $2)  AS mine,
         (SELECT COUNT(*) FROM votes
            WHERE video_id = $1 AND revision = $3 AND vote = 'up')           AS up,
         (SELECT COUNT(*) FROM votes
            WHERE video_id = $1 AND revision = $3 AND vote = 'down')         AS down,
         (SELECT vote FROM votes
            WHERE video_id = $1 AND revision = $3 AND user_id = $2)          AS your_vote`,
      [videoId, userId, revision]
    );
    const r = rows[0];
    return {
      videoId,
      revision,
      summarisedBy: r.summarised_by,
      others: r.others,
      up: r.up,
      down: r.down,
      yourVote: r.your_vote || null,
      // Lets the client decide whether summarising would cost quota without a
      // second round trip, and keeps its pre-check identical to the server's.
      youViewed: r.mine > 0,
    };
  });
}

// Whether this user has already been billed for this video. A repeat is free,
// so the quota gate has to know before it refuses anyone.
export async function hasViewed(videoId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM views WHERE video_id = $1 AND user_id = $2',
    [videoId, userId]
  );
  return rows.length > 0;
}

// `userHash` lets a deleted-and-recreated account keep the week it already
// spent - see the retired_usage table. `plan` of 'unlimited' is reported as an
// allowance nothing can exhaust, so every caller can go on treating the quota
// as a number instead of special-casing a class of user.
export async function readQuota(userId, { plan = 'free', userHash = null } = {}, now = Date.now()) {
  const week = weekKey(now);
  const { rows } = await pool.query(
    `SELECT
       COALESCE((SELECT seconds FROM weekly_usage  WHERE user_id   = $1 AND week = $2), 0)
     + COALESCE((SELECT seconds FROM retired_usage WHERE user_hash = $3 AND week = $2), 0)
       AS used`,
    [userId, week, userHash]
  );
  const usedSeconds = rows[0].used;

  if (plan === 'unlimited') {
    return {
      usedSeconds,
      limitSeconds: Infinity,
      remainingSeconds: Infinity,
      unlimited: true,
      week,
      resetsAt: weekResetsAt(now),
    };
  }

  return {
    usedSeconds,
    limitSeconds: config.weeklyQuotaSeconds,
    remainingSeconds: Math.max(0, config.weeklyQuotaSeconds - usedSeconds),
    unlimited: false,
    week,
    resetsAt: weekResetsAt(now),
  };
}

// Fixed window per user per minute, in the database so it survives a restart
// and holds across more than one instance. One extra write per request, which
// at this scale is free and at any scale is cheaper than a limit that does not
// actually limit.
export async function hitRateLimit(userId, limit) {
  const minute = Math.floor(Date.now() / 60000);
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (user_id, minute, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, minute) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [userId, minute]
  );
  return rows[0].count > limit;
}

export async function pruneRateLimits() {
  await pool.query('DELETE FROM rate_limits WHERE minute < $1', [
    Math.floor(Date.now() / 60000) - 5,
  ]);
}

// Records that this user summarised this video and bills the video's length
// against their week. One transaction, so a crash cannot leave a view counted
// but unbilled, or the reverse.
export async function commitView(videoId, userId, durationSeconds) {
  const now = Date.now();
  const seconds = Math.max(0, Math.round(durationSeconds) || 0);

  return transaction(async (client) => {
    await revisionOf(client, videoId);
    const inserted = await client.query(
      `INSERT INTO views (video_id, user_id, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (video_id, user_id) DO NOTHING`,
      [videoId, userId, now]
    );

    // Only bill the first time a user summarises a given video. Re-opening
    // something they have already paid for costs nothing to serve, so it
    // should not eat into their week either.
    if (inserted.rowCount > 0 && seconds > 0) {
      await client.query(
        `INSERT INTO weekly_usage (user_id, week, seconds) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, week) DO UPDATE SET seconds = weekly_usage.seconds + EXCLUDED.seconds`,
        [userId, weekKey(now), seconds]
      );
    }
    return { billed: inserted.rowCount > 0 ? seconds : 0 };
  });
}

// Returns the new tally plus whether this vote tipped the summary into being
// re-run. The revision bump is the signal: clients compare the revision they
// cached against the one the server reports.
export async function castVote(videoId, userId, vote) {
  const now = Date.now();

  return transaction(async (client) => {
    // Lock the video row for the duration: two simultaneous downvotes must not
    // both read "2 downvotes" and both decide to bump the revision.
    let revision = await revisionOf(client, videoId);
    await client.query('SELECT revision FROM videos WHERE video_id = $1 FOR UPDATE', [videoId]);

    if (vote === null) {
      await client.query(
        'DELETE FROM votes WHERE video_id = $1 AND user_id = $2 AND revision = $3',
        [videoId, userId, revision]
      );
    } else {
      await client.query(
        `INSERT INTO votes (video_id, user_id, revision, vote, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (video_id, user_id, revision)
         DO UPDATE SET vote = EXCLUDED.vote, updated_at = EXCLUDED.updated_at`,
        [videoId, userId, revision, vote, now]
      );
    }

    const { rows } = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE vote = 'up')   AS up,
         COUNT(*) FILTER (WHERE vote = 'down') AS down
       FROM votes WHERE video_id = $1 AND revision = $2`,
      [videoId, revision]
    );
    const up = rows[0].up;
    const down = rows[0].down;
    const total = up + down;

    // Capped at one rewrite: past that, votes still accumulate as a signal but
    // they stop costing anyone a re-run.
    const rejected =
      down >= config.downvoteMinimum && total > 0 && down / total >= config.downvoteRatio;
    const triggered = rejected && revision < config.maxRevision;

    if (triggered) {
      const bumped = await client.query(
        'UPDATE videos SET revision = revision + 1 WHERE video_id = $1 RETURNING revision',
        [videoId]
      );
      revision = bumped.rows[0].revision;
    }

    return {
      revision,
      up,
      down,
      yourVote: triggered ? null : vote,
      retired: triggered,
      // The rewrite was rejected too, and there will not be another one.
      exhausted: rejected && !triggered,
    };
  });
}

// Every video this user has been billed for. Drives the "Summarised" label.
export async function listViewedVideos(userId) {
  const { rows } = await pool.query(
    'SELECT video_id FROM views WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows.map((r) => r.video_id);
}

// Erases everything tied to one person. Deliberately does NOT delete the
// summaries they generated: those are not personal data, they belong to every
// reader who has since relied on them, and removing them would silently make
// other people pay to regenerate the same text. What goes is the link between
// this person and any of it.
//
// gemini_calls keeps its rows but loses the user id, because the spend history
// has to stay intact - it is the accounting record behind the cap.
//
// Erasure that cannot be used to refill your own allowance. The current week's
// usage is carried over to retired_usage under a salted hash before the
// identifiable rows go, so signing up again with the same Google account lands
// on the same hash and the week stays spent. The hash is one-way and expires
// with the week, so this retains the fact that *someone* spent time, not who.
export async function deleteUserData(userId, userHash) {
  const week = weekKey();

  return transaction(async (client) => {
    if (userHash) {
      await client.query(
        `INSERT INTO retired_usage (user_hash, week, seconds)
         SELECT $1, week, seconds FROM weekly_usage WHERE user_id = $2 AND week = $3
         ON CONFLICT (user_hash, week)
         DO UPDATE SET seconds = GREATEST(retired_usage.seconds, EXCLUDED.seconds)`,
        [userHash, userId, week]
      );
      // Weeks that have already rolled over cannot be refilled by deleting, so
      // there is nothing left to protect and no reason to keep the rows.
      await client.query('DELETE FROM retired_usage WHERE week < $1', [week]);
    }

    const views = await client.query('DELETE FROM views WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM votes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM weekly_usage WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    // The spend history is the accounting record behind the cap, so the rows
    // stay - but they stop pointing at a person.
    await client.query("UPDATE gemini_calls SET user_id = 'deleted' WHERE user_id = $1", [
      userId,
    ]);
    await client.query('DELETE FROM users WHERE user_id = $1', [userId]);
    return { viewsDeleted: views.rowCount };
  });
}

// ---------- anonymous readers ----------

// How many distinct videos this anonymous reader has opened today.
export async function anonReadsToday(anonId, now = Date.now()) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) AS n FROM anon_reads WHERE anon_id = $1 AND day = $2',
    [anonId, dayKey(now)]
  );
  return rows[0].n;
}

// Records that an anonymous reader opened a video, and reports what that
// leaves. Returns `repeat: true` when they had already opened this same video
// today, which costs nothing - the whole row is a no-op in that case.
//
// One transaction, because two clicks arriving together must not both read
// "4 used" and both be allowed through.
export async function commitAnonRead(anonId, videoId, limit, now = Date.now()) {
  const day = dayKey(now);

  return transaction(async (client) => {
    // There is no single row to lock here - the limit is over a COUNT, and
    // Postgres will not take FOR UPDATE on an aggregate. An advisory lock keyed
    // on the reader and the day serialises exactly the pair of clicks that
    // could otherwise both read "4 used" and both be let through. It is
    // released when the transaction ends, however it ends.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`${anonId}:${day}`]);

    const seen = await client.query(
      'SELECT 1 FROM anon_reads WHERE anon_id = $1 AND day = $2 AND video_id = $3',
      [anonId, day, videoId]
    );
    const { rows: countRows } = await client.query(
      'SELECT COUNT(*) AS n FROM anon_reads WHERE anon_id = $1 AND day = $2',
      [anonId, day]
    );
    const used = countRows[0].n;

    if (seen.rowCount > 0) {
      return { allowed: true, repeat: true, used, remaining: Math.max(0, limit - used) };
    }
    if (used >= limit) {
      return { allowed: false, repeat: false, used, remaining: 0 };
    }

    await client.query(
      'INSERT INTO anon_reads (anon_id, day, video_id, read_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [anonId, day, videoId, now]
    );
    return { allowed: true, repeat: false, used: used + 1, remaining: Math.max(0, limit - used - 1) };
  });
}

// Yesterday's rows have no job left to do. Anonymous reading is deliberately
// not a history anyone keeps.
export async function pruneAnonReads(now = Date.now()) {
  await pool.query('DELETE FROM anon_reads WHERE day < $1', [dayKey(now)]);
}

// The current summary for a video, without needing a user. Used only by the
// anonymous path, which never bills, never meters and never generates - so it
// has no reason to touch quota, views or duration.
export async function readCurrentSummary(videoId) {
  // Defaults to revision 1 rather than giving up when the videos row is
  // missing. In practice one is always written before a summary is - but the
  // summary is the thing being asked for, and refusing to hand over text that
  // demonstrably exists because a bookkeeping row does not is the wrong way
  // round. This path never writes, so it cannot repair the row either.
  const { rows } = await pool.query(
    'SELECT COALESCE((SELECT revision FROM videos WHERE video_id = $1), 1) AS revision',
    [videoId]
  );
  const { revision } = rows[0];
  const summary = await readSummary(videoId, revision);
  return summary ? { ...summary, revision } : null;
}

// ---------- summaries ----------

export async function readSummary(videoId, revision) {
  const { rows } = await pool.query(
    'SELECT markdown, model, created_at FROM summaries WHERE video_id = $1 AND revision = $2',
    [videoId, revision]
  );
  return rows[0] || null;
}

// DO NOTHING on conflict rather than overwriting: if two people asked for the
// same video at the same moment, both paid for a generation and either answer
// is equally valid. Keeping the first is arbitrary but stable, and stability is
// what matters when a dozen readers are looking at the same summary.
export async function writeSummary(videoId, revision, markdown, model) {
  await pool.query(
    `INSERT INTO summaries (video_id, revision, markdown, model, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (video_id, revision) DO NOTHING`,
    [videoId, revision, markdown, model, Date.now()]
  );
}

// ---------- settings ----------
//
// The same key/value table the user-hash salt lives in. Used here to remember
// state that has to survive a restart but is not worth an env var: which day
// the digest last covered, and which spend-alert threshold is currently active.

export async function getSetting(key, fallback = null) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// ---------- reporting ----------

// Everything the daily digest says, for the half-open interval [startMs, endMs).
// One query rather than five, because it runs once a day and there is no
// reason to make five round trips say the same thing one can.
export async function readDigestStats(startMs, endMs) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(cost_usd) FROM gemini_calls
                  WHERE created_at >= $1 AND created_at < $2), 0)::float8      AS spend_usd,
       (SELECT COUNT(*) FROM gemini_calls
          WHERE created_at >= $1 AND created_at < $2)                         AS generations,
       (SELECT COUNT(*) FROM users
          WHERE created_at >= $1 AND created_at < $2)                         AS new_users,
       (SELECT COUNT(*) FROM views
          WHERE created_at >= $1 AND created_at < $2)                         AS reads,
       (SELECT COUNT(DISTINCT user_id) FROM views
          WHERE created_at >= $1 AND created_at < $2)                         AS active_readers`,
    [startMs, endMs]
  );
  return rows[0];
}

// ---------- spend ----------

export async function logGeminiCall({
  videoId,
  userId,
  durationSeconds,
  cost,
}) {
  await pool.query(
    `INSERT INTO gemini_calls
       (video_id, user_id, duration_seconds, input_tokens, output_tokens, thought_tokens, cost_usd, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      videoId,
      userId,
      Math.round(durationSeconds) || 0,
      cost ? cost.inputTokens : 0,
      cost ? cost.outputTokens : 0,
      cost ? cost.thoughtTokens : 0,
      cost ? cost.totalUsd : 0,
      Date.now(),
    ]
  );
}

// Total spend since a given moment. The spend cap's only input.
export async function spendSince(sinceMs) {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total FROM gemini_calls WHERE created_at >= $1',
    [sinceMs]
  );
  return rows[0].total;
}

export default pool;
