/**
 * The names the file-processing tools are known by, in one place.
 *
 * Separate from `vocabulary.ts` on purpose: that file is the DOWNLOADER's
 * shared kernel, and the tools are a different feature with a different
 * lifecycle. Mixing them would mean every downloader change re-touches a file
 * the tools depend on, and vice versa.
 *
 * The keys are dotted (`image.compress`) rather than flat because the prefix is
 * load-bearing — it selects the queue, the worker concurrency and the resource
 * ceilings, so it has to be recoverable from the key alone.
 */

export const TOOL_FAMILY_VALUES = ['image', 'video', 'pdf', 'qr'] as const;

export const ToolFamily = {
  Image: 'image',
  Video: 'video',
  Pdf: 'pdf',
  Qr: 'qr',
} as const;
export type ToolFamily = (typeof ToolFamily)[keyof typeof ToolFamily];

export const ALL_TOOL_FAMILIES: readonly ToolFamily[] = TOOL_FAMILY_VALUES;

/**
 * Every operation the tools worker can perform.
 *
 * Deliberately stored as TEXT in the database rather than a PostgreSQL enum:
 * adding a tool would otherwise need a migration that rewrites a type, and the
 * project has already been bitten once by an enum value that existed in code
 * and not in the database. The application vocabulary plus a Zod check at the
 * boundary gives the same safety without the DDL.
 */
export const TOOL_KEY_VALUES = [
  'image.compress',
  'image.resize',
  'image.convert',
  'video.extract_mp3',
  'video.remove_audio',
  'pdf.images_to_pdf',
  'pdf.to_images',
  'qr.generate',
] as const;

export const ToolKey = {
  ImageCompress: 'image.compress',
  ImageResize: 'image.resize',
  ImageConvert: 'image.convert',
  VideoExtractMp3: 'video.extract_mp3',
  VideoRemoveAudio: 'video.remove_audio',
  ImagesToPdf: 'pdf.images_to_pdf',
  PdfToImages: 'pdf.to_images',
  QrGenerate: 'qr.generate',
} as const;
export type ToolKey = (typeof ToolKey)[keyof typeof ToolKey];

export const ALL_TOOL_KEYS: readonly ToolKey[] = TOOL_KEY_VALUES;

export function isToolKey(value: string): value is ToolKey {
  return (ALL_TOOL_KEYS as readonly string[]).includes(value);
}

/**
 * Which family — and therefore which queue and which ceilings — a tool belongs
 * to, derived from the key rather than kept in a second table that could
 * disagree with it.
 *
 * `pdf.images_to_pdf` is the case that makes this worth stating: it CONSUMES
 * images but is priced and queued as PDF work, because building the document is
 * where the time and memory go.
 */
export function toolFamilyOf(key: ToolKey): ToolFamily {
  const prefix = key.slice(0, key.indexOf('.'));
  // The cast is safe by construction: every key above begins with a family
  // name, and the test suite asserts that for all of them.
  return prefix as ToolFamily;
}

/**
 * The lifecycle of one tool job.
 *
 * `receiving` is separate from `processing` because fetching a 500 MB video
 * from Telegram is a distinct, slow phase that fails for entirely different
 * reasons than the conversion does — and a user watching a stuck job deserves
 * to know which half it is stuck in.
 */
export const TOOL_JOB_STATUS_VALUES = [
  'pending',
  'queued',
  'receiving',
  'processing',
  'uploading',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;

export const ToolJobStatus = {
  Pending: 'pending',
  Queued: 'queued',
  Receiving: 'receiving',
  Processing: 'processing',
  Uploading: 'uploading',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Expired: 'expired',
} as const;
export type ToolJobStatus = (typeof ToolJobStatus)[keyof typeof ToolJobStatus];

/** Statuses from which no further transition is legal. */
export const TERMINAL_TOOL_JOB_STATUSES: readonly ToolJobStatus[] = [
  ToolJobStatus.Completed,
  ToolJobStatus.Failed,
  ToolJobStatus.Cancelled,
  ToolJobStatus.Expired,
];

export function isTerminalToolJobStatus(status: ToolJobStatus): boolean {
  return TERMINAL_TOOL_JOB_STATUSES.includes(status);
}

/**
 * Every way a tool job can fail, as a closed set.
 *
 * Here rather than beside the `ToolError` class that throws it, because the CODE
 * outlives the throw: it is written to `tool_jobs.error_code`, read back by the
 * bot to explain a finished job, and translated into Persian by the presentation
 * layer. Three consumers, only one of which runs the engine.
 *
 * That distinction is load-bearing. `@tgtools/file-tools-engine` loads Sharp's
 * native binding at import, so a bot that needed this enum in order to render a
 * sentence would be linking libvips to do it. The class stays in the engine; the
 * vocabulary lives here, where `@tgtools/shared`'s zero-dependency rule makes it
 * free to import from anywhere.
 */
export const ToolErrorCode = {
  /** The user's file is larger than this deployment can even fetch. */
  InputTooLarge: 'TOOL_INPUT_TOO_LARGE',
  /** What we produced cannot be sent. Known before the upload is attempted. */
  OutputTooLarge: 'TOOL_OUTPUT_TOO_LARGE',
  UnsupportedFileType: 'UNSUPPORTED_FILE_TYPE',
  /**
   * What Telegram declared and what the bytes actually are disagree.
   *
   * Its own code rather than folded into `UNSUPPORTED_FILE_TYPE` because the
   * two mean different things to an operator: one is a user sending something
   * we do not handle, the other is a file whose extension lies — which is worth
   * noticing.
   */
  MimeMismatch: 'MIME_MISMATCH',

  InvalidImage: 'INVALID_IMAGE',
  /** A decompression bomb: a small file declaring an enormous canvas. */
  ImageTooManyPixels: 'IMAGE_TOO_MANY_PIXELS',
  AnimatedImageUnsupported: 'ANIMATED_IMAGE_UNSUPPORTED',

  InvalidVideo: 'INVALID_VIDEO',
  VideoHasNoAudio: 'VIDEO_HAS_NO_AUDIO',
  VideoAlreadyMuted: 'VIDEO_ALREADY_MUTED',
  VideoTooLong: 'VIDEO_TOO_LONG',

  InvalidPdf: 'INVALID_PDF',
  PdfEncrypted: 'PDF_ENCRYPTED',
  PdfTooManyPages: 'PDF_TOO_MANY_PAGES',
  InvalidPageRange: 'INVALID_PAGE_RANGE',

  QrInputTooLong: 'QR_INPUT_TOO_LONG',

  DiskSpaceLow: 'DISK_SPACE_LOW',
  ToolTimeout: 'TOOL_TIMEOUT',
  ToolCancelled: 'TOOL_CANCELLED',
  TelegramFileUnavailable: 'TELEGRAM_FILE_UNAVAILABLE',
  TelegramUploadFailed: 'TELEGRAM_UPLOAD_FAILED',
  /** ffmpeg, pdftocairo or pdfinfo exited non-zero for a reason we did not model. */
  ExternalToolFailed: 'EXTERNAL_TOOL_FAILED',
  InternalError: 'INTERNAL_ERROR',
} as const;
export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

export const ALL_TOOL_ERROR_CODES: readonly ToolErrorCode[] = Object.freeze(
  Object.values(ToolErrorCode),
);

export function isToolErrorCode(value: string): value is ToolErrorCode {
  return (ALL_TOOL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Which failures are worth a second attempt.
 *
 * The default is NO. Retrying a corrupt PDF, an encrypted one, a video with no
 * audio track or an oversized input burns the same CPU to reach the same
 * answer, and on a shared worker that is capacity taken from someone whose job
 * would have succeeded. Only genuinely transient conditions are listed.
 */
const RETRYABLE_CODES: ReadonlySet<ToolErrorCode> = new Set([
  ToolErrorCode.DiskSpaceLow,
  ToolErrorCode.TelegramFileUnavailable,
  ToolErrorCode.TelegramUploadFailed,
  ToolErrorCode.InternalError,
]);

export function isRetryableToolError(code: ToolErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}
