import { isValidShortId } from '../../domain/value-objects/job-id.js';

/**
 * Telegram caps `callback_data` at 64 bytes, so nothing that identifies the
 * media itself can travel in it — a URL alone would blow the budget several
 * times over. What goes in is a short job handle and an option id; everything
 * else is looked up server-side, which also means a crafted callback cannot
 * describe a download of its own.
 */
export const CALLBACK_PREFIX = 'dl';
export const CALLBACK_MAX_BYTES = 64;

export const CallbackAction = {
  SelectQuality: 'q',
  Cancel: 'x',
} as const;
export type CallbackAction = (typeof CallbackAction)[keyof typeof CallbackAction];

export interface DownloadCallback {
  readonly shortId: string;
  readonly action: CallbackAction;
  readonly optionId: string | undefined;
}

const SEPARATOR = ':';
const OPTION_ID_PATTERN = /^[a-z0-9]{1,12}$/;

export function encodeCallback(callback: DownloadCallback): string {
  const parts = [CALLBACK_PREFIX, callback.shortId, callback.action];
  if (callback.optionId !== undefined) parts.push(callback.optionId);
  const encoded = parts.join(SEPARATOR);
  if (Buffer.byteLength(encoded, 'utf8') > CALLBACK_MAX_BYTES) {
    // A silent truncation here would produce a button that looks fine and does
    // nothing, which is far harder to diagnose than a loud failure at build time.
    throw new Error(`Callback data exceeds ${CALLBACK_MAX_BYTES} bytes: ${encoded}`);
  }
  return encoded;
}

/**
 * Returns `undefined` for anything that is not ours, rather than throwing:
 * callback data is user-controllable, and an unrecognised value is an ordinary
 * event — an old keyboard, another feature's button — not an exception.
 */
export function decodeCallback(raw: string | undefined): DownloadCallback | undefined {
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw, 'utf8') > CALLBACK_MAX_BYTES) return undefined;

  const parts = raw.split(SEPARATOR);
  const [prefix, shortId, action, optionId] = parts;
  if (prefix !== CALLBACK_PREFIX) return undefined;
  if (parts.length < 3 || parts.length > 4) return undefined;
  if (shortId === undefined || !isValidShortId(shortId)) return undefined;
  if (action !== CallbackAction.SelectQuality && action !== CallbackAction.Cancel) return undefined;

  if (action === CallbackAction.SelectQuality) {
    if (optionId === undefined || !OPTION_ID_PATTERN.test(optionId)) return undefined;
    return { shortId, action, optionId };
  }

  return { shortId, action, optionId: undefined };
}

/** Matches any callback this feature owns, for grammY's `callbackQuery` filter. */
export const DOWNLOAD_CALLBACK_PATTERN = /^dl:[0-9A-HJKMNP-TV-Z]{6,16}:[qx](?::[a-z0-9]{1,12})?$/;
