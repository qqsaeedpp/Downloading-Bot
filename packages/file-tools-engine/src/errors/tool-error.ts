/**
 * Every way a tool job can fail, as a closed set.
 *
 * Two audiences, deliberately separated. The CODE drives behaviour — whether to
 * retry, what to tell the user, which metric to move — and the raw cause stays
 * in the log. A user who sends a corrupt PDF should read one clear sentence in
 * Persian, not a poppler stack trace; and an operator debugging the same event
 * needs the stack trace, not the sentence.
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

export interface ToolErrorOptions {
  /** Structured, already-safe context for the log. Never raw tool output. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Overrides the table above when one call site knows better. */
  readonly retryable?: boolean;
}

/**
 * The only error type the processors throw.
 *
 * `message` is for the log and is never shown to a user — the presentation
 * layer maps {@link code} to Persian text. Keeping the two apart is what stops
 * an ffmpeg stderr line reaching a chat window.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ToolErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolError';
    this.code = code;
    this.retryable = options.retryable ?? isRetryableToolError(code);
    this.context = options.context ?? {};
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

/**
 * Wrap anything that escaped a processor.
 *
 * An unrecognised failure becomes `INTERNAL_ERROR` and is retryable, on the
 * reasoning that we do not know it is permanent — the opposite default from the
 * modelled codes, where we do.
 */
export function toToolError(error: unknown, fallbackMessage = 'tool failed'): ToolError {
  if (isToolError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(ToolErrorCode.InternalError, `${fallbackMessage}: ${message}`, {
    cause: error,
  });
}
