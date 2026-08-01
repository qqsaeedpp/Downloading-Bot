/**
 * Every way a download can fail, from the product's point of view.
 *
 * The set is closed and exhaustive on purpose: the Persian message table is
 * keyed by it, so `switch` statements over these codes are checked by the
 * compiler and a new code cannot ship without a message to go with it.
 */
export const DownloadFailureCode = {
  InvalidUrl: 'INVALID_URL',
  UnsupportedPlatform: 'UNSUPPORTED_PLATFORM',
  UnsupportedMedia: 'UNSUPPORTED_MEDIA',
  PrivateMedia: 'PRIVATE_MEDIA',
  LoginRequired: 'LOGIN_REQUIRED',
  /** The platform refused this deployment, not this user. See the engine code. */
  PlatformBlocked: 'PLATFORM_BLOCKED',
  MediaNotFound: 'MEDIA_NOT_FOUND',
  FormatUnavailable: 'FORMAT_UNAVAILABLE',
  MediaTooLarge: 'MEDIA_TOO_LARGE',
  DownloadTimeout: 'DOWNLOAD_TIMEOUT',
  ProcessingTimeout: 'PROCESSING_TIMEOUT',
  DownloadFailed: 'DOWNLOAD_FAILED',
  ProcessingFailed: 'PROCESSING_FAILED',
  UploadFailed: 'UPLOAD_FAILED',
  JobCancelled: 'JOB_CANCELLED',
  RateLimited: 'RATE_LIMITED',
  TooManyActiveJobs: 'TOO_MANY_ACTIVE_JOBS',
  SelectionExpired: 'SELECTION_EXPIRED',
  InternalError: 'INTERNAL_ERROR',
} as const;

export type DownloadFailureCode = (typeof DownloadFailureCode)[keyof typeof DownloadFailureCode];

/**
 * Codes for which another attempt is pointless. A private post does not become
 * public because we asked twice, and retrying only delays the user's answer
 * while occupying a worker slot.
 */
export const PERMANENT_FAILURE_CODES: ReadonlySet<DownloadFailureCode> = new Set([
  DownloadFailureCode.InvalidUrl,
  DownloadFailureCode.UnsupportedPlatform,
  DownloadFailureCode.UnsupportedMedia,
  DownloadFailureCode.PrivateMedia,
  DownloadFailureCode.LoginRequired,
  DownloadFailureCode.MediaNotFound,
  DownloadFailureCode.FormatUnavailable,
  DownloadFailureCode.MediaTooLarge,
  // Retrying from the same address produces the same refusal, so a retry only
  // burns a worker slot and adds to whatever tripped the check.
  DownloadFailureCode.PlatformBlocked,
  DownloadFailureCode.JobCancelled,
  DownloadFailureCode.TooManyActiveJobs,
  DownloadFailureCode.SelectionExpired,
]);

export function isPermanentFailure(code: DownloadFailureCode): boolean {
  return PERMANENT_FAILURE_CODES.has(code);
}
