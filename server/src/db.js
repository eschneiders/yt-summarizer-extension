import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);

// WAL so a read never blocks behind a write; this service is read-heavy
// (every panel open asks for stats) with occasional small writes.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    video_id      TEXT PRIMARY KEY,
    -- Bumped when downvotes cross the threshold. Clients holding a summary
    -- from an earlier revision re-summarise on next open; votes are recorded
    -- against a revision so the ones that triggered a re-run cannot
    -- immediately trigger the next one.
    revision      INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS views (
    video_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    -- One row per user, so the counter reads "people", not "clicks".
    PRIMARY KEY (video_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    video_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    revision   INTEGER NOT NULL,
    vote       TEXT    NOT NULL CHECK (vote IN ('up', 'down')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (video_id, user_id, revision)
  );

  CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT    NOT NULL,
    week    TEXT    NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, week)
  );

  CREATE INDEX IF NOT EXISTS idx_votes_video ON votes (video_id, revision);
  CREATE INDEX IF NOT EXISTS idx_views_video ON views (video_id);
`);

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

// ---------- statements ----------

const stmt = {
  upsertVideo: db.prepare(
    'INSERT INTO videos (video_id, first_seen_at) VALUES (?, ?) ON CONFLICT (video_id) DO NOTHING'
  ),
  getVideo: db.prepare('SELECT revision FROM videos WHERE video_id = ?'),
  bumpRevision: db.prepare('UPDATE videos SET revision = revision + 1 WHERE video_id = ?'),

  insertView: db.prepare(
    'INSERT INTO views (video_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (video_id, user_id) DO NOTHING'
  ),
  countOthers: db.prepare(
    'SELECT COUNT(*) AS n FROM views WHERE video_id = ? AND user_id != ?'
  ),
  hasViewed: db.prepare('SELECT 1 AS yes FROM views WHERE video_id = ? AND user_id = ?'),
  countAll: db.prepare('SELECT COUNT(*) AS n FROM views WHERE video_id = ?'),

  setVote: db.prepare(`
    INSERT INTO votes (video_id, user_id, revision, vote, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (video_id, user_id, revision)
    DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at
  `),
  clearVote: db.prepare(
    'DELETE FROM votes WHERE video_id = ? AND user_id = ? AND revision = ?'
  ),
  getVote: db.prepare(
    'SELECT vote FROM votes WHERE video_id = ? AND user_id = ? AND revision = ?'
  ),
  tallyVotes: db.prepare(`
    SELECT
      SUM(CASE WHEN vote = 'up'   THEN 1 ELSE 0 END) AS up,
      SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END) AS down
    FROM votes WHERE video_id = ? AND revision = ?
  `),

  getUsage: db.prepare('SELECT seconds FROM usage WHERE user_id = ? AND week = ?'),
  addUsage: db.prepare(`
    INSERT INTO usage (user_id, week, seconds) VALUES (?, ?, ?)
    ON CONFLICT (user_id, week) DO UPDATE SET seconds = seconds + excluded.seconds
  `),
};

// ---------- operations ----------

function revisionOf(videoId) {
  stmt.upsertVideo.run(videoId, Date.now());
  return stmt.getVideo.get(videoId).revision;
}

export function readStats(videoId, userId) {
  const revision = revisionOf(videoId);
  const tally = stmt.tallyVotes.get(videoId, revision);
  return {
    videoId,
    revision,
    summarisedBy: stmt.countAll.get(videoId).n,
    others: stmt.countOthers.get(videoId, userId).n,
    up: tally.up || 0,
    down: tally.down || 0,
    yourVote: (stmt.getVote.get(videoId, userId, revision) || {}).vote || null,
    // Lets the client decide whether a summarise would cost quota without a
    // second round trip, and keeps its pre-check identical to the server's.
    youViewed: hasViewed(videoId, userId),
  };
}

// Whether this user has already been billed for this video. A repeat is free,
// so the quota gate has to know before it refuses anyone.
export function hasViewed(videoId, userId) {
  return !!stmt.hasViewed.get(videoId, userId);
}

export function readQuota(userId, now = Date.now()) {
  const week = weekKey(now);
  const row = stmt.getUsage.get(userId, week);
  const usedSeconds = row ? row.seconds : 0;
  return {
    usedSeconds,
    limitSeconds: config.weeklyQuotaSeconds,
    remainingSeconds: Math.max(0, config.weeklyQuotaSeconds - usedSeconds),
    week,
    resetsAt: weekResetsAt(now),
  };
}

// Records that this user summarised this video and bills the video's length
// against their week. Runs as one transaction so a crash cannot leave a view
// counted but unbilled, or the reverse.
export function commitView(videoId, userId, durationSeconds) {
  const now = Date.now();
  const seconds = Math.max(0, Math.round(durationSeconds) || 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    revisionOf(videoId);
    const inserted = stmt.insertView.run(videoId, userId, now);
    // Only bill the first time a user summarises a given video. Re-opening
    // something they already have costs nothing to serve, so it should not
    // eat into their week either.
    if (inserted.changes > 0 && seconds > 0) {
      stmt.addUsage.run(userId, weekKey(now), seconds);
    }
    db.exec('COMMIT');
    return { billed: inserted.changes > 0 ? seconds : 0 };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Returns the new tally plus whether this vote tipped the summary into being
// re-run. The revision bump is the signal: clients compare the revision they
// cached against the one the server reports.
export function castVote(videoId, userId, vote) {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    let revision = revisionOf(videoId);

    if (vote === null) stmt.clearVote.run(videoId, userId, revision);
    else stmt.setVote.run(videoId, userId, revision, vote, now);

    const tally = stmt.tallyVotes.get(videoId, revision);
    const up = tally.up || 0;
    const down = tally.down || 0;
    const total = up + down;

    // Capped at one rewrite: past that, votes still accumulate as a signal but
    // they stop costing anyone a re-run.
    const rejected =
      down >= config.downvoteMinimum && total > 0 && down / total >= config.downvoteRatio;
    const triggered = rejected && revision < config.maxRevision;

    if (triggered) {
      stmt.bumpRevision.run(videoId);
      revision = stmt.getVideo.get(videoId).revision;
    }

    db.exec('COMMIT');
    return {
      revision,
      up,
      down,
      yourVote: triggered ? null : vote,
      retired: triggered,
      // The rewrite was rejected too, and there will not be another one.
      exhausted: rejected && !triggered,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export default db;
