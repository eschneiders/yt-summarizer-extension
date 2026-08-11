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

  // What someone gets before signing in: this many *already-written* summaries
  // a day, counted per video so re-opening one is free. Generating is never
  // anonymous, so this allowance only ever hands out things that cost nothing
  // to serve - which is exactly why it is safe to let it be resettable.
  anonDailyReads: num(process.env.YTS_ANON_DAILY_READS, 5),

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

  // YouTube Data API v3, used for one thing: deciding how long a video is
  // instead of believing the client. Same Google Cloud project as the Gemini
  // key, different API - enable "YouTube Data API v3" on it. Without this the
  // server takes the client's word, which is fine on a laptop and wrong the
  // moment anyone but us can reach the service.
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  youtubeTimeoutMs: num(process.env.YTS_YOUTUBE_TIMEOUT_MS, 5000),

  // Google sign-in. The client id ships inside the extension and is public by
  // design; the secret is what lets this server exchange an authorisation code
  // for an identity, and never leaves it. Using the code flow rather than
  // returning a token straight to the extension is precisely so the secret can
  // live here.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',

  // How long a sign-in lasts before it has to be repeated.
  sessionDays: num(process.env.YTS_SESSION_DAYS, 90),

  // The backstop. Checked before every call that would cost money, so a bug or
  // an attacker hits a wall rather than a bill. At the measured rate of ~92
  // minutes of video per cent, $2 is roughly 180,000 minutes a day - orders of
  // magnitude above real use, which is what a circuit breaker should be.
  dailySpendCapUsd: num(process.env.YTS_DAILY_SPEND_CAP_USD, 2),

  // Videos longer than this are refused outright. Cost scales with length, so
  // one stray three-hour podcast is the expensive mistake worth blocking.
  maxVideoSeconds: num(process.env.YTS_MAX_VIDEO_SECONDS, 3600),

  // Generations in flight per user. One was too strict: clicking a second card
  // while the first is still thinking is normal behaviour, not abuse, and it
  // met a refusal. Three still walls off a client stuck in a loop, which is
  // what this actually defends against - and the spend cap sits behind it
  // either way.
  //
  // Note the alternative, cancelling the first, would be worse than useless:
  // that call is already being paid for, and it is allowed to finish precisely
  // so the summary gets stored and everyone after gets it free.
  maxConcurrentPerUser: num(process.env.YTS_MAX_CONCURRENT_PER_USER, 3),
};

// Checked before anything connects to anything. A misconfigured deploy should
// say what is wrong in its first log line, not throw a driver stack trace four
// minutes later when a healthcheck gives up - that failure mode looks like a
// broken server rather than an unset variable, and it is the one people
// actually hit on a first deploy.
export function validateConfig() {
  const problems = [];

  // Copying a setup guide and leaving the angle brackets in is the single most
  // common way this goes wrong, so name it explicitly rather than letting it
  // surface as a connection-string parse error.
  const placeholder = (value) => /^<.*>$/.test(String(value).trim());

  if (!config.databaseUrl) {
    problems.push('DATABASE_URL is not set.');
  } else if (placeholder(config.databaseUrl)) {
    problems.push(
      'DATABASE_URL still contains the placeholder text from the setup guide. ' +
        'Replace it with the connection string from your database provider.'
    );
  } else if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    problems.push('DATABASE_URL does not look like a Postgres URL (postgresql://…).');
  }

  // Absent is fine - the service still serves summaries other people generated,
  // it just cannot make new ones. Placeholder text is never fine.
  if (config.geminiApiKey && placeholder(config.geminiApiKey)) {
    problems.push(
      'GEMINI_API_KEY still contains the placeholder text from the setup guide.'
    );
  }
  if (config.youtubeApiKey && placeholder(config.youtubeApiKey)) {
    problems.push(
      'YOUTUBE_API_KEY still contains the placeholder text from the setup guide.'
    );
  }

  if (problems.length) {
    console.error('\n[yts:api] cannot start - configuration problems:\n');
    problems.forEach((p) => console.error('  · %s', p));
    console.error('');
    process.exit(1);
  }

  if (!config.geminiApiKey) {
    console.warn(
      '[yts:api] no GEMINI_API_KEY set - existing summaries will be served, but no new ones can be generated.'
    );
  }
  if (!config.youtubeApiKey) {
    console.warn(
      '[yts:api] no YOUTUBE_API_KEY set - video length is taken from the client, so anyone ' +
        'who can call this API can understate it and summarise long videos for nothing. ' +
        'Fine locally; set it before the service is reachable by anyone else.'
    );
  }
  if (!config.googleClientId || !config.googleClientSecret) {
    console.warn(
      '[yts:api] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not both set - nobody can sign in, so every request will be rejected.'
    );
  }
  if (config.allowedOrigins.includes('*')) {
    console.warn('[yts:api] YTS_ALLOWED_ORIGINS is "*" - any website can call this API.');
  }
}
