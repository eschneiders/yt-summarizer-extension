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

export async function readQuota(userId, now = Date.now()) {
  const week = weekKey(now);
  const { rows } = await pool.query(
    'SELECT seconds FROM weekly_usage WHERE user_id = $1 AND week = $2',
    [userId, week]
  );
  const usedSeconds = rows.length ? rows[0].seconds : 0;
  return {
    usedSeconds,
    limitSeconds: config.weeklyQuotaSeconds,
    remainingSeconds: Math.max(0, config.weeklyQuotaSeconds - usedSeconds),
    week,
    resetsAt: weekResetsAt(now),
  };
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
// KNOWN HOLE, closes with real authentication: this also clears weekly_usage,
// so "delete my data" is currently a way to reset your own allowance. It is not
// worth defending today because identity is a client-minted UUID - anyone
// wanting a fresh allowance can just send a different one, no deletion needed.
// Once the user id is a Google `sub` and therefore stable, this must instead
// retain the current week's usage under a salted hash of the id, with readQuota
// summing both. That keeps erasure meaningful while making the allowance
// survive a delete-and-signup cycle.
export async function deleteUserData(userId) {
  return transaction(async (client) => {
    const views = await client.query('DELETE FROM views WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM votes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM weekly_usage WHERE user_id = $1', [userId]);
    await client.query(
      "UPDATE gemini_calls SET user_id = 'deleted' WHERE user_id = $1",
      [userId]
    );
    return { viewsDeleted: views.rowCount };
  });
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
