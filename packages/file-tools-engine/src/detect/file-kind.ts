import { extname } from 'node:path';
import type { ToolFamily } from '@tgtools/shared';
import { fileTypeFromFile } from 'file-type';
import { ToolError, ToolErrorCode } from '../errors/tool-error.js';

/**
 * What a file actually IS, decided from its bytes.
 *
 * Everything Telegram tells us about a file came from the sending client:
 * `mime_type` is that client's guess and `file_name` is whatever the user
 * typed. Neither is evidence. The signature in the first few bytes is, and it
 * is the only thing this module lets decide whether a tool may run.
 *
 * The declared values are not discarded, though — they are what makes the
 * ERROR useful. A `.zip` renamed to `.pdf` and a `.zip` sent as a `.zip` are
 * the same bytes and completely different mistakes, and only one of them
 * deserves to be told "this file does not match its extension".
 */

/** The three input families a tool can require. QR takes no file at all. */
export type InputKind = Extract<ToolFamily, 'image' | 'video' | 'pdf'>;

/**
 * Types that carry no information.
 *
 * Telegram labels a great many perfectly ordinary documents
 * `application/octet-stream`. Reading that as a contradiction would reject most
 * of what users actually send.
 */
const GENERIC_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
]);

/**
 * The family a MIME type belongs to, or `undefined` when it names none of them.
 *
 * `audio/*` deliberately maps to nothing: it shares neither a container nor a
 * tool with video, and "remove the audio from this MP3" is not a request that
 * can succeed.
 */
export function kindOfMimeType(mimeType: string | undefined): InputKind | undefined {
  if (mimeType === undefined || mimeType === '') return undefined;
  const normalized = mimeType.trim().toLowerCase();
  if (GENERIC_MIME_TYPES.has(normalized)) return undefined;

  if (normalized === 'application/pdf') return 'pdf';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  return undefined;
}

/** Extensions worth honouring when the MIME type says nothing useful. */
const EXTENSION_KINDS: Readonly<Record<string, InputKind>> = {
  pdf: 'pdf',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  avif: 'image',
  gif: 'image',
  heic: 'image',
  heif: 'image',
  tif: 'image',
  tiff: 'image',
  bmp: 'image',
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  avi: 'video',
  m4v: 'video',
};

/**
 * What the file CLAIMED to be, from the sender's own metadata.
 *
 * The declared MIME type wins over the extension: one was computed by the
 * sending client and the other was typed by a person. Only the LAST extension
 * counts — `invoice.pdf.exe` claims to be an executable, and treating the
 * embedded `.pdf` as the claim is how a mislabelled file talks its way past a
 * check meant to catch exactly that.
 */
export function claimedKindOf(
  declaredMimeType: string | undefined,
  declaredFileName: string | undefined,
): InputKind | undefined {
  const fromMime = kindOfMimeType(declaredMimeType);
  if (fromMime !== undefined) return fromMime;

  if (declaredFileName === undefined || declaredFileName === '') return undefined;
  const extension = extname(declaredFileName).replace(/^\./, '').toLowerCase();
  if (extension === '') return undefined;
  return EXTENSION_KINDS[extension];
}

/**
 * Read a file's signature.
 *
 * Returns `undefined` rather than throwing when nothing matches: an
 * unrecognised file is an ordinary user mistake, and the caller — which knows
 * what the file was supposed to be — is better placed to say so.
 *
 * Only the first few kilobytes are read, whatever the file's size. That matters
 * on this worker: the input may be a 2 GB video, and deciding whether to reject
 * it must not begin by reading all of it.
 */
export async function sniffFileType(path: string): Promise<string | undefined> {
  try {
    const result = await fileTypeFromFile(path);
    return result?.mime;
  } catch {
    // Unreadable is not "unrecognised", but the two are the same answer here:
    // the caller cannot proceed either way, and the file-system error would
    // surface again — with better context — at the first real read.
    return undefined;
  }
}

export interface ResolveInputKindOptions {
  /** From the file's own signature. `undefined` when nothing recognised it. */
  readonly sniffedMimeType: string | undefined;
  readonly expected: InputKind;
  readonly declaredMimeType?: string | undefined;
  readonly declaredFileName?: string | undefined;
}

export interface ResolvedInput {
  readonly kind: InputKind;
  /** The sniffed type, which is the one every downstream decision uses. */
  readonly mimeType: string;
}

/**
 * Decide whether a file may be handed to a tool, and say why not when it may
 * not.
 *
 * The two failures are deliberately different codes. `MIME_MISMATCH` means the
 * file claimed to be usable and its bytes say otherwise — that is worth telling
 * the user, because "this does not match its extension" points at something
 * they can fix. `UNSUPPORTED_FILE_TYPE` means they simply sent the wrong thing
 * and there is no contradiction to report; saying "does not match its
 * extension" there would send someone hunting for a problem that is not real.
 *
 * Neither is retryable. A file does not become a different format on the second
 * attempt, and on a shared worker a pointless retry is capacity taken from a job
 * that would have succeeded.
 */
export function resolveInputKind(options: ResolveInputKindOptions): ResolvedInput {
  const sniffedKind = kindOfMimeType(options.sniffedMimeType);

  if (sniffedKind === options.expected && options.sniffedMimeType !== undefined) {
    return { kind: sniffedKind, mimeType: options.sniffedMimeType };
  }

  const claimed = claimedKindOf(options.declaredMimeType, options.declaredFileName);

  // Context carries the TYPES, never the filename: filenames reach logs, and
  // this one has already been used once to lie about the contents.
  const context = {
    expected: options.expected,
    sniffedMimeType: options.sniffedMimeType ?? 'unrecognised',
    claimedKind: claimed ?? 'none',
  };

  if (claimed === options.expected) {
    throw new ToolError(
      ToolErrorCode.MimeMismatch,
      'the file claimed to be usable but its signature says otherwise',
      { context },
    );
  }

  throw new ToolError(
    ToolErrorCode.UnsupportedFileType,
    'the file is not of a kind this tool can act on',
    { context },
  );
}
