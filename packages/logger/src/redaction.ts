/**
 * Paths Pino replaces with `[redacted]` before anything reaches a transport.
 *
 * This list is the last line of defence, not the first: nothing should be
 * putting a secret in a log context to begin with. It exists because "should"
 * is not a guarantee, and a bot token in a shipped log line is unrecoverable —
 * the token has to be rotated, and you rarely find out in time.
 */
export const REDACTED_PATHS: readonly string[] = [
  'token',
  '*.token',
  'botToken',
  '*.botToken',
  'telegramBotToken',
  '*.telegramBotToken',
  'password',
  '*.password',
  'cookies',
  '*.cookies',
  'cookie',
  '*.cookie',
  'cookieContent',
  '*.cookieContent',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'REDIS_URL',
  '*.REDIS_URL',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
];

/**
 * Anything that looks like a Telegram bot token, wherever it turns up — a
 * stringified error, a URL in a stack trace. Pino's `redact` only walks object
 * paths, so free text needs its own pass.
 */
const BOT_TOKEN_PATTERN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;
/** `postgresql://user:secret@host` and friends. */
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;

export function scrubText(value: string): string {
  return value
    .replace(BOT_TOKEN_PATTERN, '<bot-token>')
    .replace(URL_CREDENTIALS_PATTERN, '$1$2:<redacted>@');
}
