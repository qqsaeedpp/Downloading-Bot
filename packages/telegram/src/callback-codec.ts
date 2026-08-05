/**
 * The one place callback data is written and read.
 *
 * Telegram gives `callback_data` 64 BYTES — not characters — and silently
 * refuses to send a keyboard whose button exceeds it. That failure arrives as a
 * broken menu with no error attached to the button that caused it, so the limit
 * is enforced here, at construction, where the offending value is still in
 * hand.
 *
 * The wire format is deliberately positional and terse:
 *
 *     <namespace>:<version>:<action>[:<arg>]
 *
 * A JSON payload would be self-describing and would also spend half the budget
 * on punctuation. Anything that does not fit — a file id, a path, the text of a
 * QR code, a settings object — does not belong here at all; it belongs in the
 * session, addressed by a short opaque handle.
 */

/** Telegram's hard limit, in bytes of UTF-8. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** Bumped only when a payload's MEANING changes incompatibly. */
export const CALLBACK_VERSION = 'v1';

const SEPARATOR = ':';

/**
 * Namespaces, kept short because every byte competes with the argument.
 *
 * `tm` is the tool menu, `it`/`vt`/`pt`/`qt` the four families, and `jb` job
 * actions such as cancel. The downloader's existing callbacks use none of these
 * prefixes, so the two schemes cannot collide.
 */
export const CallbackNamespace = {
  ToolMenu: 'tm',
  ImageTool: 'it',
  VideoTool: 'vt',
  PdfTool: 'pt',
  QrTool: 'qt',
  Job: 'jb',
} as const;
export type CallbackNamespace = (typeof CallbackNamespace)[keyof typeof CallbackNamespace];

const ALL_NAMESPACES: readonly string[] = Object.values(CallbackNamespace);

export interface DecodedCallback {
  readonly namespace: CallbackNamespace;
  readonly version: string;
  readonly action: string;
  /** Absent rather than empty when the action carries no argument. */
  readonly arg: string | undefined;
}

/**
 * Thrown only by {@link encodeCallback}, which is a programming error at build
 * time. Decoding never throws: hostile or stale input is an expected condition
 * and is reported by returning `undefined`.
 */
export class CallbackEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallbackEncodingError';
  }
}

/** Only these may appear in an action or argument; see {@link encodeCallback}. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Build callback data, or throw if it could not be delivered.
 *
 * The character restriction is not cosmetic. A separator smuggled into an
 * argument would re-parse as an extra field and shift every following one,
 * which is how a "cancel" button becomes a "confirm" button. Restricting the
 * alphabet makes that unrepresentable rather than merely unlikely.
 */
export function encodeCallback(namespace: CallbackNamespace, action: string, arg?: string): string {
  if (!SAFE_SEGMENT.test(action)) {
    throw new CallbackEncodingError(
      `callback action "${action}" may contain only letters, digits, "-" and "_"`,
    );
  }
  if (arg !== undefined && !SAFE_SEGMENT.test(arg)) {
    throw new CallbackEncodingError(
      `callback argument for "${action}" may contain only letters, digits, "-" and "_"`,
    );
  }

  const parts = [namespace, CALLBACK_VERSION, action];
  if (arg !== undefined) parts.push(arg);
  const encoded = parts.join(SEPARATOR);

  // Measured in bytes, not characters: Telegram counts the UTF-8 encoding, and
  // a length check would pass a string that the API then rejects.
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new CallbackEncodingError(
      `callback data is ${String(bytes)} bytes, over Telegram's ${String(CALLBACK_DATA_MAX_BYTES)}-byte limit: "${encoded}". ` +
        'Put the value in the session and reference it by a short handle.',
    );
  }

  return encoded;
}

/**
 * Parse callback data, returning `undefined` for anything unrecognised.
 *
 * Never throws. Every button ever sent stays clickable forever — a user can
 * scroll back a month and press one — so unknown namespaces, retired versions
 * and outright garbage are all ordinary inputs, not exceptional ones. The
 * caller decides what to tell the user; this only decides whether it parsed.
 */
export function decodeCallback(data: string | undefined): DecodedCallback | undefined {
  if (data === undefined || data === '') return undefined;

  const parts = data.split(SEPARATOR);
  // Namespace, version, action, and at most one argument.
  if (parts.length < 3 || parts.length > 4) return undefined;

  const [namespace, version, action, arg] = parts;
  if (namespace === undefined || version === undefined || action === undefined) return undefined;
  if (!ALL_NAMESPACES.includes(namespace)) return undefined;
  // An empty segment anywhere means the payload was truncated or hand-made.
  // Accepting an empty VERSION was the subtle one: it decodes to something that
  // looks structurally fine, then fails the version check with a message about
  // an outdated button rather than a malformed one.
  if (version === '' || action === '') return undefined;
  if (arg !== undefined && arg === '') return undefined;

  return {
    namespace: namespace as CallbackNamespace,
    version,
    action,
    arg,
  };
}

/**
 * True when the payload parsed AND was written by a version this build still
 * understands.
 *
 * Split from {@link decodeCallback} so a caller can tell "this button is from
 * an older release, tell the user to reopen the menu" apart from "this is not
 * one of our buttons at all", which deserves silence rather than a message.
 */
export function isCurrentVersion(decoded: DecodedCallback): boolean {
  return decoded.version === CALLBACK_VERSION;
}

/**
 * A short, opaque handle for addressing something too large for callback data.
 *
 * Base36 of 5 bytes: 8 characters, ~1.1e12 values, which is ample for handles
 * that live for fifteen minutes and are scoped to one user. Not a security
 * boundary — the handler must still check that the session belongs to the
 * caller — but short enough to leave room for the rest of the payload.
 */
export function createShortId(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(5);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value.toString(36).padStart(8, '0').slice(0, 8);
}
