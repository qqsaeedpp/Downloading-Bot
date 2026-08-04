/**
 * Telegram's public Bot API, and the only place this URL is written down.
 *
 * Everything that needs it — the client factory's fallback, the file resolver,
 * the startup log lines in both processes — imports it from here. Four copies
 * of a string that decides where a bot token is sent is four chances for one of
 * them to drift, and the failure that produces (a worker still talking to the
 * public API while the bot uses the local server) is invisible until a file
 * larger than 50 MB is rejected.
 *
 * Its own module rather than living in the factory so that a leaf utility can
 * use it without pulling in grammY and the whole config type.
 */
export const PUBLIC_BOT_API_ROOT = 'https://api.telegram.org';

/**
 * The same value, marked for human eyes in a log line.
 *
 * A reader seeing a bare URL cannot tell whether it was configured or defaulted,
 * and that distinction is the first thing anyone debugging an upload limit wants
 * to know.
 */
export const PUBLIC_BOT_API_ROOT_LABEL = `${PUBLIC_BOT_API_ROOT} (public)`;
