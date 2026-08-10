-- Applied idempotently at boot. There is no migration tool yet because there
-- is no production data yet; once there is, this becomes migration 001 and
-- changes stop being made in place.
--
-- Timestamps are epoch milliseconds in BIGINT rather than timestamptz. That is
-- deliberate: the API hands these straight to JavaScript clients, and one
-- representation end to end is one fewer place for a timezone to go wrong.

CREATE TABLE IF NOT EXISTS videos (
  video_id      TEXT PRIMARY KEY,
  -- Bumped when downvotes cross the threshold. Clients holding a summary from
  -- an earlier revision re-summarise on next open; votes are recorded against
  -- a revision so the ones that triggered a re-run cannot immediately trigger
  -- the next one. Capped by YTS_MAX_REVISION.
  revision      INTEGER NOT NULL DEFAULT 1,
  first_seen_at BIGINT  NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_votes_video   ON votes (video_id, revision);
CREATE INDEX IF NOT EXISTS idx_views_video   ON views (video_id);
-- The spend cap sums this window before every call, so it must be indexed.
CREATE INDEX IF NOT EXISTS idx_calls_created ON gemini_calls (created_at);
