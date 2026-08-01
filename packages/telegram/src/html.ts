/** Telegram's HTML parse mode: only these four need escaping. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Bot API hard limits. Exceeding either is a 400, not a truncation. */
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
export const TELEGRAM_CAPTION_MAX_LENGTH = 1024;

/**
 * Clip to a limit without splitting an HTML entity in half — `&amp` with the
 * semicolon shaved off makes Telegram reject the whole message.
 */
export function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength - 1);
  const lastAmpersand = clipped.lastIndexOf('&');
  const safe =
    lastAmpersand !== -1 && !clipped.slice(lastAmpersand).includes(';')
      ? clipped.slice(0, lastAmpersand)
      : clipped;
  return `${safe.trimEnd()}…`;
}

export function clampCaption(value: string): string {
  return clampText(value, TELEGRAM_CAPTION_MAX_LENGTH);
}

export function clampMessage(value: string): string {
  return clampText(value, TELEGRAM_MESSAGE_MAX_LENGTH);
}
