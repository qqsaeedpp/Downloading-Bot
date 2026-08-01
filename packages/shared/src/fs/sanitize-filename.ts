/**
 * Names arriving from an extractor are attacker-influenced: they come from a
 * post title someone else wrote. They reach `-o` templates, the filesystem and
 * Telegram's `filename` field, so every one of them is scrubbed here first.
 */

/** Reserved on Windows even with an extension; harmless to refuse everywhere. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Path separators plus the characters Windows refuses outright. */
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*]/g;

/**
 * Code points that must not survive into a filename. Filtered by value rather
 * than by a character-class regex so the ranges stay readable and this source
 * file never has to contain a literal control character.
 */
const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], // C0 controls
  [0x7f, 0x9f], // DEL and the C1 controls
  [0x200b, 0x200f], // zero-width space .. right-to-left mark
  [0x202a, 0x202e], // bidi embedding / override
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // byte-order mark
];

function stripForbiddenCodePoints(value: string): string {
  let out = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (FORBIDDEN_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) continue;
    out += character;
  }
  return out;
}

export interface SanitizeFilenameOptions {
  /** Ceiling in *bytes*, not characters — ext4 caps a name at 255 bytes. */
  readonly maxBytes?: number;
  readonly fallback?: string;
}

export interface SanitizedFilename {
  readonly name: string;
  readonly base: string;
  readonly extension: string;
}

/**
 * Reduce an arbitrary string to a single safe path segment.
 *
 * Guarantees: contains no separator, is not `.`/`..`, is not a Windows device
 * name, is non-empty, and its UTF-8 length is at most `maxBytes`. The extension
 * is preserved when one can be recognised, because Telegram picks its preview
 * behaviour from it.
 */
export function sanitizeFilename(
  input: string,
  options: SanitizeFilenameOptions = {},
): SanitizedFilename {
  const maxBytes = options.maxBytes ?? 120;
  const fallback = options.fallback ?? 'media';

  // Take the last segment first: a title of "../../etc/passwd" must not survive
  // as a path, and splitting on both separators covers Windows-shaped input too.
  const lastSegment = input.split(/[/\\]/).pop() ?? '';

  const cleaned = stripForbiddenCodePoints(lastSegment.normalize('NFC'))
    .replace(ILLEGAL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot hides the file; a trailing dot or space is silently dropped
    // by Windows, which would make the name we recorded differ from the name on
    // disk.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  const { base: rawBase, extension } = splitExtension(cleaned);
  let base = rawBase;

  if (base === '' || WINDOWS_RESERVED.has(base.toLowerCase())) base = fallback;

  base = truncateToBytes(base, Math.max(1, maxBytes - Buffer.byteLength(extension, 'utf8')));
  if (base === '') base = fallback;

  return { name: `${base}${extension}`, base, extension };
}

/**
 * Split a trailing extension, but only when it looks like one. A title ending in
 * ".Best moment" must not turn into a 12-character extension.
 */
function splitExtension(value: string): { base: string; extension: string } {
  const match = /^(.*)(\.[A-Za-z0-9]{1,8})$/.exec(value);
  if (match === null) return { base: value, extension: '' };
  const [, base = '', extension = ''] = match;
  if (base === '') return { base: value, extension: '' };
  return { base, extension: extension.toLowerCase() };
}

/** Truncate on a character boundary so the result is never invalid UTF-8. */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    out += character;
    used += size;
  }
  return out.replace(/[.\s]+$/, '');
}
