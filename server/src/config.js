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

  // Where the daily report and spend alerts go. Both are optional - unset
  // either and the server runs exactly as before, just quieter. Get the token
  // from @BotFather; get the chat id by messaging the bot once and reading it
  // off GET https://api.telegram.org/bot<token>/getUpdates.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // YouTube Data API v3, used for one thing: deciding how long a video is
  // instead of believing the client. Same Google Cloud project as the Gemini
  // key, different API - enable "YouTube Data API v3" on it. Without this the
  // server takes the client's word, which is fine on a laptop and wrong the
  // moment anyone but us can reach the service.
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  youtubeTimeoutMs: num(process.env.YTS_YOUTUBE_TIMEOUT_MS, 5000),

  // The free tier is 10,000 units a day, and one videos.list call is 1 unit -
  // so this is really "videos nobody has ever summarised before, per day".
  // Nothing reports how much is left, so the server counts its own calls and
  // says something at the halfway mark. Not a limit: crossing it changes
  // nothing except that a message gets sent, which is the point - it is the
  // difference between finding out at 5,000 and finding out at 10,000, when
  // new videos have already started being refused.
  youtubeDailyQuotaUnits: num(process.env.YTS_YOUTUBE_DAILY_QUOTA, 10000),
  youtubeQuotaWarnUnits: num(process.env.YTS_YOUTUBE_QUOTA_WARN, 5000),

  // Google sign-in. The client id ships inside the extension and is public by
  // design; the secret is what lets this server exchange an authorisation code
  // for an identity, and never leaves it. Using the code flow rather than
  // returning a token straight to the extension is precisely so the secret can
  // live here.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',

  // How long a sign-in lasts before it has to be repeated.
  sessionDays: num(process.env.YTS_SESSION_DAYS, 90),

  // What a summary actually costs, measured from real billing rather than from
  // list prices: 138 generations averaging ~20 minutes came to 29c, which is
  // ~92 minutes of video per US cent. (Cross-check: 138 * 20 / 92 = 30c.)
  //
  // estimateCost() in gemini.js works from published per-token prices and comes
  // out roughly 4x high. That overstatement is deliberate where it is used - the
  // spend cap should err towards stopping early - but it is simply wrong in a
  // report, which is answering "what did I spend", not "what is the worst case".
  // So the two numbers are kept apart: the cap uses tokens, the report uses this.
  //
  // There is no API that reports a Gemini API key's real balance or spend, so a
  // measured rate is the honest best available. Update it if billing drifts.
  measuredMinutesPerCent: num(process.env.YTS_MEASURED_MINUTES_PER_CENT, 92),

  // The backstop. Checked before every call that would cost money, so a bug or
  // an attacker hits a wall rather than a bill. At the measured rate of ~92
  // minutes of video per cent, $2 is roughly 180,000 minutes a day - orders of
  // magnitude above real use, which is what a circuit breaker should be.
  dailySpendCapUsd: num(process.env.YTS_DAILY_SPEND_CAP_USD, 2),

  // Video length is the intended paid driver, so the ceiling is per-plan rather
  // than global. The reasoning is not the obvious one: length is not sold
  // because it is expensive - at ~92 min/cent a three-hour video costs about
  // two cents - but because it is the one limit a second free account cannot
  // get you past. Selling *quantity* would mean selling something both cheap to
  // give away and trivially farmed by signing up again; selling *capability* is
  // neither.
  //
  // YTS_FREE_MAX_VIDEO_MINUTES is meant to move. Somewhere in 20-40 is the
  // interesting range, and where exactly is an empirical question about real
  // demand - see the length-distribution query in CONTEXT.md. It stays at 60
  // until there is something to upgrade *to*, because a wall with nothing
  // behind it is just a worse product.
  freeMaxVideoSeconds: num(process.env.YTS_FREE_MAX_VIDEO_MINUTES, 60) * 60,
  plusMaxVideoSeconds: num(process.env.YTS_PLUS_MAX_VIDEO_MINUTES, 240) * 60,

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

// The longest video a given plan may summarise. Anything that is not 'free'
// gets the higher ceiling, so a future 'plus' works without touching this.
export function maxVideoSecondsFor(plan) {
  return plan === 'free' || !plan ? config.freeMaxVideoSeconds : config.plusMaxVideoSeconds;
}

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
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn(
      '[yts:api] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not both set - no daily report, no spend alerts.'
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
