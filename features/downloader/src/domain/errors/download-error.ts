import { AppError } from '@tgtools/shared';
import type { AppErrorOptions } from '@tgtools/shared';
import { DownloadFailureCode, isPermanentFailure } from './download-failure-code.js';

/**
 * The only error type that crosses out of this feature.
 *
 * Whatever went wrong underneath — a yt-dlp exit code, a Postgres constraint, a
 * Telegram 400 — it arrives at the presentation layer as one of these, with a
 * code that maps to a sentence a person can act on.
 */
export class DownloadError extends AppError {
  readonly code: DownloadFailureCode;
  readonly retryable: boolean;

  constructor(
    code: DownloadFailureCode,
    message: string,
    options: AppErrorOptions & { retryable?: boolean } = {},
  ) {
    super(message, options);
    this.code = code;
    this.retryable = options.retryable ?? !isPermanentFailure(code);
  }

  static invalidUrl(message = 'The link could not be understood'): DownloadError {
    return new DownloadError(DownloadFailureCode.InvalidUrl, message);
  }

  static unsupportedPlatform(message = 'No supported platform claims this link'): DownloadError {
    return new DownloadError(DownloadFailureCode.UnsupportedPlatform, message);
  }

  static selectionExpired(): DownloadError {
    return new DownloadError(
      DownloadFailureCode.SelectionExpired,
      'This selection is no longer valid',
    );
  }

  static tooManyActiveJobs(limit: number): DownloadError {
    return new DownloadError(
      DownloadFailureCode.TooManyActiveJobs,
      `User already has ${limit} active downloads`,
      { context: { limit } },
    );
  }

  static internal(message: string, cause?: unknown): DownloadError {
    return new DownloadError(DownloadFailureCode.InternalError, message, { cause });
  }
}

export function isDownloadError(value: unknown): value is DownloadError {
  return value instanceof DownloadError;
}

/**
 * Last-resort narrowing. An error that reaches the presentation layer without a
 * code is a bug, but the user still deserves a sentence rather than a silence.
 */
export function toDownloadError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  return new DownloadError(
    DownloadFailureCode.InternalError,
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
