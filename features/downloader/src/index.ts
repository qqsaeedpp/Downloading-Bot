export { createDownloaderFeature } from './downloader.feature.js';
export type {
  CreateDownloaderFeatureOptions,
  DownloaderFeature,
  DownloaderFeatureDependencies,
} from './downloader.feature.js';

export { DownloadFailureCode, isPermanentFailure } from './domain/errors/download-failure-code.js';
export { DownloadError, isDownloadError, toDownloadError } from './domain/errors/download-error.js';
export {
  ACTIVE_STATUSES,
  DownloadJobStatus,
  InvalidStatusTransitionError,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
} from './domain/entities/job-status.js';
export { isJobActive, isSelectionStillValid } from './domain/entities/download-job.js';
export type { DownloadJob } from './domain/entities/download-job.js';
export type { MediaFormat, MediaInfo, MediaStatistics } from './domain/entities/media-info.js';
export { findOption, toQualityString } from './domain/value-objects/download-option.js';
export type { DownloadOption } from './domain/value-objects/download-option.js';
export { SHORT_ID_LENGTH, isValidShortId } from './domain/value-objects/job-id.js';
export type { MediaUrl, StorableUrl } from './domain/value-objects/media-url.js';

export type {
  DownloadContext,
  DownloadMediaRequest,
  DownloadedMedia,
  InspectMediaRequest,
  MediaDownloaderPort,
} from './domain/ports/media-downloader.port.js';
export type {
  CreateDownloadJobInput,
  DownloadJobRepository,
  UpdateJobOutputInput,
  UpdateJobProgressInput,
  UpdateJobSelectionInput,
  UpdateJobStatusInput,
} from './domain/ports/download-job.repository.js';
export type {
  DownloadAccessPolicy,
  DownloadEventRepository,
  DownloadJobPayload,
  DownloadProgressReporter,
  DownloadQueuePort,
  MediaInspectionCache,
  MediaInspectionCacheKey,
  SendMediaCommand,
  SentMedia,
  TelegramMediaSenderPort,
} from './domain/ports/supporting-ports.js';

export { ProgressThrottler } from './application/services/progress-throttler.js';
export { ProgressWriter } from './application/services/progress-writer.js';
export type { ProgressWriterOptions } from './application/services/progress-writer.js';
export { InspectMediaUseCase } from './application/use-cases/inspect-media.use-case.js';
export { RequestDownloadUseCase } from './application/use-cases/request-download.use-case.js';
export { ProcessDownloadUseCase } from './application/use-cases/process-download.use-case.js';
export type { ProcessDownloadOutcome } from './application/use-cases/process-download.use-case.js';
export { CancelDownloadUseCase } from './application/use-cases/cancel-download.use-case.js';
export { GetDownloadStatusUseCase } from './application/use-cases/get-download-status.use-case.js';
export { CleanupExpiredDownloadsUseCase } from './application/use-cases/cleanup-expired-downloads.use-case.js';

export {
  DOWNLOAD_JOB_NAME,
  BullMqDownloadQueue,
  downloadJobPayloadSchema,
  parseDownloadJobPayload,
} from './infrastructure/queue/bullmq-download-queue.js';
export {
  CANCEL_CHANNEL,
  RedisCancellationBus,
} from './infrastructure/queue/redis-cancellation-bus.js';
export type { DownloadCancellationBus } from './domain/ports/supporting-ports.js';
export { GrammyMediaSender } from './infrastructure/telegram/grammy-media-sender.js';
export { DrizzleDownloadJobRepository } from './infrastructure/persistence/drizzle-download-job.repository.js';
export {
  DrizzleDownloadEventRepository,
  sanitizePayload,
} from './infrastructure/persistence/drizzle-download-event.repository.js';
export {
  RedisMediaInspectionCache,
  buildKey,
} from './infrastructure/cache/redis-media-inspection-cache.js';
export { DefaultDownloadAccessPolicy } from './infrastructure/policy/default-access-policy.js';
export {
  EngineMediaDownloader,
  toDomainError,
  toMediaInfo,
} from './infrastructure/providers/engine-media-downloader.adapter.js';

export {
  CALLBACK_MAX_BYTES,
  CALLBACK_PREFIX,
  CallbackAction,
  DOWNLOAD_CALLBACK_PATTERN,
  decodeCallback,
  encodeCallback,
} from './presentation/telegram/callback-data.js';
export type { DownloadCallback } from './presentation/telegram/callback-data.js';
export {
  PLATFORM_LABELS_FA,
  fa,
  supportedPlatformsFa,
  toPersianDigits,
} from './presentation/telegram/messages/fa.js';
export {
  buildCancelKeyboard,
  buildQualityKeyboard,
} from './presentation/telegram/keyboards/quality.keyboard.js';
export { renderMediaCard } from './presentation/telegram/presenters/media-card.presenter.js';
export { TelegramProgressReporter } from './presentation/telegram/reporters/telegram-progress-reporter.js';
