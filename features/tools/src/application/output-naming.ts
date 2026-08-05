import type { ToolKey } from '@tgtools/shared';
import { sanitizeFilename } from '@tgtools/shared';

/**
 * What the file is called when it lands back in the user's chat.
 *
 * Two rules do the work here, and both come from a real failure mode rather
 * than from taste.
 *
 * The name is derived from the SOURCE, because the result arrives in a chat
 * that already contains the original and a generated name makes the pair
 * impossible to match up. The extension is derived from what was actually
 * PRODUCED, because a `.png` that now contains WebP makes Telegram show the
 * wrong icon and makes several clients refuse to open it.
 *
 * The source name is attacker-controlled. It never builds a path — the
 * workspace generates every path it opens — but it IS handed to Telegram as
 * `filename`, so it goes through `sanitizeFilename` first.
 */

export interface OutputNameInput {
  readonly tool: ToolKey;
  /** Without the dot. What the processor actually wrote. */
  readonly extension: string;
  /** The user's own filename, if their client sent one. */
  readonly sourceName?: string | undefined;
  /** For `pdf.to_images`, which produces one file per page. */
  readonly pageNumber?: number | undefined;
  readonly pageCount?: number | undefined;
}

/** ext4's ceiling is 255 BYTES; the extension and any suffix have to fit inside it. */
const MAX_NAME_BYTES = 255;

/** Used when the client sent no filename — a phone camera photo, typically. */
const FALLBACK_BASE: Readonly<Record<string, string>> = {
  'image.compress': 'compressed',
  'image.resize': 'resized',
  'image.convert': 'converted',
  'video.extract_mp3': 'audio',
  'video.remove_audio': 'muted',
  'pdf.images_to_pdf': 'document',
  'pdf.to_images': 'page',
  'qr.generate': 'qr',
};

function baseNameOf(input: OutputNameInput): string {
  // QR is deliberately never named after its content: that content may be a
  // Wi-Fi password, and a filename would carry it into the chat, the
  // notification preview and the user's download folder.
  if (input.tool === 'qr.generate') return 'qr';

  // Building a PDF from an album has no single source to be named after.
  if (input.tool === 'pdf.images_to_pdf') return 'document';

  if (input.sourceName === undefined || input.sourceName === '') {
    return FALLBACK_BASE[input.tool] ?? 'output';
  }

  const sanitized = sanitizeFilename(input.sourceName, {
    // Leave room for the extension, the dot, and any suffix added below.
    maxBytes: MAX_NAME_BYTES - 32,
    fallback: FALLBACK_BASE[input.tool] ?? 'output',
  });
  return sanitized.base === '' ? (FALLBACK_BASE[input.tool] ?? 'output') : sanitized.base;
}

/**
 * Letters and digits only.
 *
 * VALIDATED rather than sanitised, because unlike the base name this does not
 * come from the user: the processor knows what it just wrote. Anything else is
 * a bug in the caller, and `bin` is the honest answer to "we do not know what
 * this is".
 */
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,12}$/;

export function outputFileName(input: OutputNameInput): string {
  const base = baseNameOf(input);
  const extension = SAFE_EXTENSION.test(input.extension) ? input.extension.toLowerCase() : 'bin';
  return `${base}${suffixFor(input)}.${extension}`;
}

function suffixFor(input: OutputNameInput): string {
  // A muted video otherwise has the same name, the same extension and silently
  // different content — sitting in the same chat as the file it came from.
  if (input.tool === 'video.remove_audio') return '-بی‌صدا';

  if (input.tool === 'pdf.to_images' && input.pageNumber !== undefined) {
    // Zero-padded to the width of the LAST page number, so the files sort in
    // reading order. Unpadded, every file manager puts page 10 before page 2.
    const width = String(input.pageCount ?? input.pageNumber).length;
    return `-${String(input.pageNumber).padStart(width, '0')}`;
  }

  return '';
}
