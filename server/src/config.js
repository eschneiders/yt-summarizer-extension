// Everything tunable lives here so the thresholds are one grep away rather
// than buried in the query that uses them.

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 8787),

  // SQLite because the whole dataset is counters keyed by videoId, and a file
  // on disk removes a moving part from a service that has no other state.
  dbPath: process.env.YTS_DB_PATH || new URL('../data/yts.sqlite', import.meta.url).pathname,

  // The free tier. Minutes of *video input* per user per ISO week - video
  // length is what the summary actually costs, so it is what gets metered.
  weeklyQuotaSeconds: num(process.env.YTS_WEEKLY_QUOTA_MINUTES, 300) * 60,

  // A summary is re-run when enough readers call it bad. Both conditions have
  // to hold: an absolute floor, so three people cannot bin a summary nobody
  // else has read, and a majority, so a popular summary is not re-run because
  // it collected a handful of downvotes among hundreds of ups.
  downvoteMinimum: num(process.env.YTS_DOWNVOTE_MINIMUM, 3),
  downvoteRatio: num(process.env.YTS_DOWNVOTE_RATIO, 0.6),

  // One re-run and no more. If the rewrite is also rejected, the problem is
  // not the summary - it is a video the model cannot do much with, and paying
  // for a third, fourth and fifth attempt at it is throwing money at a wall.
  // Revision 1 is the original, 2 is its one replacement.
  maxRevision: num(process.env.YTS_MAX_REVISION, 2),

  // '*' is right for a dev build talking to localhost. Set this to the
  // extension origin (chrome-extension://<id>) before this is reachable from
  // anywhere but your own machine.
  allowedOrigins: (process.env.YTS_ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()),

  rateLimitPerMinute: num(process.env.YTS_RATE_LIMIT_PER_MINUTE, 120),
};
