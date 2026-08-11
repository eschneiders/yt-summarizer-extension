-- Applied idempotently at boot. There is no migration tool yet because there
-- is no production data yet; once there is, this becomes migration 001 and
-- changes stop being made in place.
--
-- Timestamps are epoch milliseconds in BIGINT rather than timestamptz. That is
-- deliberate: the API hands these straight to JavaScript clients, and one
-- representation end to end is one fewer place for a timezone to go wrong.

-- Small key/value store for things that must be stable across restarts but
-- should not be a deployment variable someone can forget to set.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- user_id is the Google `sub` claim: stable for the life of the account, and
-- not the email, which people change.
CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  email        TEXT,
  -- 'free' is metered against the weekly allowance. 'unlimited' skips it.
  plan         TEXT   NOT NULL DEFAULT 'free',
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

-- Opaque random strings, not JWTs. Every request hits the database anyway to
-- check quota, so a signed token buys nothing and costs the ability to revoke:
-- deleting the row logs someone out immediately.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT   NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- Erasure must not hand back a fresh allowance. When an account is deleted its
-- usage for the current week survives here, keyed by a salted hash of the id
-- rather than the id itself, and readQuota counts it. Signing up again with the
-- same Google account lands on the same hash, so the week stays spent. Rows
-- older than the current week are pruned - the abuse they prevent has expired
-- along with the week.
CREATE TABLE IF NOT EXISTS retired_usage (
  user_hash TEXT    NOT NULL,
  week      TEXT    NOT NULL,
  seconds   INTEGER NOT NULL,
  PRIMARY KEY (user_hash, week)
);

-- There was briefly an anonymous tier - a forgeable id buying a few
-- already-written summaries a day without an account. It is gone: the panel's
-- "sign in, it's free" message turned out to be persuasive enough on its own,
-- and one identity model is far less to reason about than two. Dropped rather
-- than left behind, because a table nothing writes to is a table someone will
-- eventually wonder about.
DROP TABLE IF EXISTS anon_reads;

-- Rate limiting in the database rather than in memory, so it holds across a
-- restart and across more than one instance.
CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT    NOT NULL,
  minute  BIGINT  NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, minute)
);

CREATE TABLE IF NOT EXISTS videos (
  video_id      TEXT PRIMARY KEY,
  -- Bumped when downvotes cross the threshold. Clients holding a summary from
  -- an earlier revision re-summarise on next open; votes are recorded against
  -- a revision so the ones that triggered a re-run cannot immediately trigger
  -- the next one. Capped by YTS_MAX_REVISION.
  revision      INTEGER NOT NULL DEFAULT 1,
  -- The video's real length, from the YouTube Data API, written once and read
  -- forever after. This is what the weekly allowance and the length cap are
  -- metered against - the client also sends a duration, but it is only a hint
  -- for the button label. NULL means nobody has looked it up yet.
  duration_seconds INTEGER,
  first_seen_at BIGINT  NOT NULL
);

-- videos predates duration_seconds, so add it to a database that already has
-- rows. Cheap and idempotent, same as everything else in this file.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

CREATE TABLE IF NOT EXISTS views (
  video_id   TEXT   NOT NULL,
  user_id    TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  -- One row per user, so the counter reads "people", not "clicks".
  PRIMARY KEY (video_id, user_id)
);

CREATE TABLE IF NOT EXISTS votes (
  video_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  revision   INTEGER NOT NULL,
  vote       TEXT    NOT NULL CHECK (vote IN ('up', 'down')),
  updated_at BIGINT  NOT NULL,
  PRIMARY KEY (video_id, user_id, revision)
);

CREATE TABLE IF NOT EXISTS weekly_usage (
  user_id TEXT    NOT NULL,
  week    TEXT    NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week)
);

-- The summaries themselves. One row per (video, revision): a video is
-- summarised once and every reader gets that same text, which is the entire
-- economic argument for the service existing. A revision bump from downvotes
-- means the next reader generates a new row rather than overwriting the old.
CREATE TABLE IF NOT EXISTS summaries (
  video_id   TEXT    NOT NULL,
  revision   INTEGER NOT NULL,
  markdown   TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  created_at BIGINT  NOT NULL,
  PRIMARY KEY (video_id, revision)
);

-- Every paid call, with what it cost. This is both the spend cap's input and
-- the answer to "why was yesterday expensive".
CREATE TABLE IF NOT EXISTS gemini_calls (
  id               BIGSERIAL PRIMARY KEY,
  video_id         TEXT   NOT NULL,
  user_id          TEXT   NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  thought_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(10, 6) NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL
);

-- Things that went wrong badly enough to be worth a person's attention. One row
-- per (day, kind): a failure that repeats all day is one row with a count, not
-- five hundred rows, because the second occurrence tells you nothing the first
-- did not. `sample` keeps the most recent message - the thing you actually need
-- in order to fix it.
--
-- Deliberately not a log. Anything routine (a refused quota, a video over the
-- length cap, someone signing in wrong) belongs in stdout and nowhere near
-- here. This table exists so that "is anything broken" is one cheap query.
CREATE TABLE IF NOT EXISTS incidents (
  day      TEXT   NOT NULL,
  kind     TEXT   NOT NULL,
  count    INTEGER NOT NULL DEFAULT 1,
  sample   TEXT   NOT NULL,
  first_at BIGINT NOT NULL,
  last_at  BIGINT NOT NULL,
  PRIMARY KEY (day, kind)
);

-- Units of YouTube Data API quota spent per day. We have to count these
-- ourselves: the API bills 1 unit per videos.list call and never tells you how
-- much of the 10,000/day you have left.
--
-- The day here is a *Pacific* day, because that is when Google resets the
-- quota. Using UTC would put the counter out of step with the thing it is
-- counting for the last eight hours of every day.
CREATE TABLE IF NOT EXISTS api_usage (
  day   TEXT    PRIMARY KEY,
  units INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_votes_video   ON votes (video_id, revision);
CREATE INDEX IF NOT EXISTS idx_views_video   ON views (video_id);
-- The spend cap sums this window before every call, so it must be indexed.
CREATE INDEX IF NOT EXISTS idx_calls_created ON gemini_calls (created_at);
