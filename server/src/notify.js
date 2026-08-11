import { config } from './config.js';

// One function, one destination for now. The daily digest and the spend
// alerts both call this rather than talking to Telegram directly, so adding
// email later - the user asked, it is possible, just not built - means
// changing this file and nothing that calls it.

export async function notify(text) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          // No Markdown/HTML parse_mode: the digest embeds a video count and a
          // dollar figure, nothing that needs formatting, and skipping it means
          // a stray character in future copy can never break delivery.
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[yts:api] Telegram notify failed: HTTP %d %s', res.status, body.slice(0, 200));
    }
  } catch (err) {
    // A failed notification must never take the server down or block whatever
    // triggered it - it is a side channel, not a dependency.
    console.error('[yts:api] Telegram notify failed:', err.message);
  }
}
