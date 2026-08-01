import { AppError } from '@tgtools/shared';
import type { AppErrorOptions } from '@tgtools/shared';

/**
 * Technical failure vocabulary. The feature translates these into its own
 * domain codes and, from there, into Persian; nothing here is ever shown to a
 * user, so the names optimise for precision rather than tone.
 */
export const EngineFailureCode = {
  InvalidUrl: 'INVALID_URL',
  UnsupportedPlatform: 'UNSUPPORTED_PLATFORM',
  UnsupportedMedia: 'UNSUPPORTED_MEDIA',
  PrivateMedia: 'PRIVATE_MEDIA',
  LoginRequired: 'LOGIN_REQUIRED',
  MediaNotFound: 'MEDIA_NOT_FOUND',
  FormatUnavailable: 'FORMAT_UNAVAILABLE',
  MediaTooLarge: 'MEDIA_TOO_LARGE',
  GeoRestricted: 'GEO_RESTRICTED',
  RateLimited: 'RATE_LIMITED',
  DownloadTimeout: 'DOWNLOAD_TIMEOUT',
  ProcessingTimeout: 'PROCESSING_TIMEOUT',
  DownloadFailed: 'DOWNLOAD_FAILED',
  ProcessingFailed: 'PROCESSING_FAILED',
  Cancelled: 'CANCELLED',
  ToolchainMissing: 'TOOLCHAIN_MISSING',
  InsufficientStorage: 'INSUFFICIENT_STORAGE',
  Internal: 'INTERNAL_ERROR',
} as const;

export type EngineFailureCode = (typeof EngineFailureCode)[keyof typeof EngineFailureCode];

export interface EngineErrorOptions extends AppErrorOptions {
  /**
   * Whether the same request could plausibly succeed on a second attempt. A
   * private post will never become public because we asked twice; a socket
   * timeout might.
   */
  readonly retryable?: boolean;
}

export class EngineError extends AppError {
  readonly code: EngineFailureCode;
  readonly retryable: boolean;

  constructor(code: EngineFailureCode, message: string, options: EngineErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
  }
}

/**
 * The default retry disposition per code. Getting this wrong is expensive in
 * both directions: retrying a permanent failure burns a worker slot and
 * hammers an extractor that already said no, while not retrying a transient one
 * loses a job to a single dropped packet.
 */
const DEFAULT_RETRYABLE: ReadonlySet<EngineFailureCode> = new Set([
  EngineFailureCode.DownloadTimeout,
  EngineFailureCode.ProcessingTimeout,
  EngineFailureCode.DownloadFailed,
  EngineFailureCode.ProcessingFailed,
  EngineFailureCode.RateLimited,
]);

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}
