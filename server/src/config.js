// Everything tunable lives here so the thresholds are one grep away rather
// than buried in the query that uses them.

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 8787),

  // Managed Postgres. Railway, Render and Neon all supply DATABASE_URL.
  databaseUrl:
    process.env.DATABASE_URL || 'postgres://localhost:5432/yts_test',
  // Hosted providers terminate TLS with a certificate this process cannot
  // chain locally, so verification is off there and irrelevant on a socket.
  databaseSsl: process.env.YTS_DATABASE_SSL === 'true',
  poolSize: num(process.env.YTS_POOL_SIZE, 10),

  // The free tier. Minutes of *video input* per user per ISO week - video
  // length is what the summary actually costs, so it is what gets metered.
  // Measured rate is ~92 minutes of video per US cent, so 400 minutes is about
  // 4.3c/week, or roughly 19c/month for someone who uses the whole allowance
  // every week. Most will not come close.
  weeklyQuotaSeconds: num(process.env.YTS_WEEKLY_QUOTA_MINUTES, 400) * 60,

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

  // The server now pays for every Gemini call, so this key is the one secret
  // that actually costs money if it leaks. Never sent to a client.
  geminiApiKey: process.env.GEMINI_API_KEY || '',

  // The backstop. Checked before every call that would cost money, so a bug or
  // an attacker hits a wall rather than a bill. At the measured rate of ~92
  // minutes of video per cent, $2 is roughly 180,000 minutes a day - orders of
  // magnitude above real use, which is what a circuit breaker should be.
  dailySpendCapUsd: num(process.env.YTS_DAILY_SPEND_CAP_USD, 2),

  // Videos longer than this are refused outright. Cost scales with length, so
  // one stray three-hour podcast is the expensive mistake worth blocking.
  maxVideoSeconds: num(process.env.YTS_MAX_VIDEO_SECONDS, 3600),

  // One generation in flight per user. Stops a loop in a client - or an
  // impatient person clicking ten cards - turning into ten paid calls.
  maxConcurrentPerUser: num(process.env.YTS_MAX_CONCURRENT_PER_USER, 1),
};
