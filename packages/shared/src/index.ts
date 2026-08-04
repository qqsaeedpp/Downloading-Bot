export { ok, err, isOk, isErr, mapResult, unwrap } from './result.js';
export type { Result } from './result.js';

export {
  AppError,
  ConfigurationError,
  InvariantViolationError,
  assertNever,
  describeError,
  isAppError,
} from './errors/app-error.js';
export type { AppErrorOptions } from './errors/app-error.js';

export { createNoopLogger } from './logging/logger.port.js';
export type { LogContext, Logger, LogLevel } from './logging/logger.port.js';

export { ManualClock, SystemClock } from './time/clock.js';
export type { Clock } from './time/clock.js';

export { CryptoIdGenerator, SequentialIdGenerator, isUuid } from './ids/id-generator.js';
export type { IdGenerator } from './ids/id-generator.js';

export {
  ALL_DOWNLOAD_TYPES,
  ALL_MEDIA_PLATFORMS,
  DOWNLOAD_TYPE_VALUES,
  DownloadStage,
  DownloadType,
  MEDIA_KIND_VALUES,
  MEDIA_PLATFORM_VALUES,
  MediaKind,
  MediaPlatform,
  VIDEO_DELIVERY_MODES,
  isDownloadType,
  isMediaPlatform,
} from './media/vocabulary.js';
// `VideoDeliveryMode` is a bare type alias — unlike its neighbours it has no
// `const` of the same name to merge with, so it cannot ride in the value block.
export type { DownloadProgress, VideoDeliveryMode } from './media/vocabulary.js';

export { normalizeProgress } from './media/progress.js';
export type { NormalizedProgress } from './media/progress.js';

export { sanitizeFilename, truncateToBytes } from './fs/sanitize-filename.js';
export type { SanitizeFilenameOptions, SanitizedFilename } from './fs/sanitize-filename.js';

export { PathEscapeError, assertContainedPath, isPathInside } from './fs/path-safety.js';

export {
  bytesToMegabytes,
  formatBytes,
  formatDuration,
  megabytesToBytes,
  renderProgressBar,
} from './format/units.js';

export {
  OperationCancelledError,
  OperationTimeoutError,
  createAbortScope,
  delay,
  isCancellation,
  isTimeoutAbort,
  throwIfAborted,
  toAbortError,
  withTimeout,
} from './async/cancellation.js';
export type { AbortScope, AbortScopeOptions } from './async/cancellation.js';

export { hashUrl, redactUrl, stripUrlQuery, truncateForStorage } from './privacy/redact.js';

export { installGracefulShutdown } from './lifecycle/graceful-shutdown.js';
export type { GracefulShutdownOptions, ShutdownStep } from './lifecycle/graceful-shutdown.js';

export { healthCheck, startHealthServer } from './health/health-server.js';
export type {
  HealthCheck,
  HealthCheckResult,
  HealthServer,
  HealthServerOptions,
} from './health/health-server.js';
