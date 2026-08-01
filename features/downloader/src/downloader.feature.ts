import type { AppConfig } from '@tgtools/config';
import type { Db } from '@tgtools/database';
import type { EngineBundle } from '@tgtools/downloader-engine';
import type { Clock, IdGenerator, Logger, MediaPlatform } from '@tgtools/shared';
import { hashUrl, stripUrlQuery } from '@tgtools/shared';
import type { AppContext, BotFeature } from '@tgtools/telegram';
import type { Queue } from 'bullmq';
import { Composer } from 'grammy';
import type { Redis } from 'ioredis';
import { CancelDownloadUseCase } from './application/use-cases/cancel-download.use-case.js';
import { CleanupExpiredDownloadsUseCase } from './application/use-cases/cleanup-expired-downloads.use-case.js';
import { GetDownloadStatusUseCase } from './application/use-cases/get-download-status.use-case.js';
import { InspectMediaUseCase } from './application/use-cases/inspect-media.use-case.js';
import { ProcessDownloadUseCase } from './application/use-cases/process-download.use-case.js';
import { RequestDownloadUseCase } from './application/use-cases/request-download.use-case.js';
import type { DownloadJobRepository } from './domain/ports/download-job.repository.js';
import type { MediaDownloaderPort } from './domain/ports/media-downloader.port.js';
import type {
  DownloadCancellationBus,
  DownloadJobPayload,
  MediaInspectionCache,
  TelegramMediaSenderPort,
} from './domain/ports/supporting-ports.js';
import type { StorableUrl } from './domain/value-objects/media-url.js';
import { RedisMediaInspectionCache } from './infrastructure/cache/redis-media-inspection-cache.js';
import { DrizzleDownloadEventRepository } from './infrastructure/persistence/drizzle-download-event.repository.js';
import { DrizzleDownloadJobRepository } from './infrastructure/persistence/drizzle-download-job.repository.js';
import { DefaultDownloadAccessPolicy } from './infrastructure/policy/default-access-policy.js';
import {
  EngineMediaDownloader,
  toDomainError,
} from './infrastructure/providers/engine-media-downloader.adapter.js';
import { BullMqDownloadQueue } from './infrastructure/queue/bullmq-download-queue.js';
import { DOWNLOAD_CALLBACK_PATTERN } from './presentation/telegram/callback-data.js';
import { createDownloadCallbackHandler } from './presentation/telegram/handlers/download-callback.handler.js';
import { createLinkMessageHandler } from './presentation/telegram/handlers/link-message.handler.js';
import { fa } from './presentation/telegram/messages/fa.js';

export interface DownloaderFeatureDependencies {
  readonly config: AppConfig;
  readonly db: Db;
  readonly redis: Redis;
  readonly engine: EngineBundle;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly downloadQueue: Queue<DownloadJobPayload>;
}

/**
 * Everything the feature exposes, assembled once.
 *
 * The bot process uses `botFeature`; the worker process uses the use cases and
 * ports. Both get them from here, so there is exactly one place where this
 * feature's wiring lives and exactly one place to look when it is wrong.
 */
export interface DownloaderFeature {
  readonly botFeature: BotFeature;
  readonly processDownload: ProcessDownloadUseCase;
  readonly cleanupExpired: CleanupExpiredDownloadsUseCase;
  readonly getStatus: GetDownloadStatusUseCase;
  readonly jobs: DownloadJobRepository;
  readonly cache: MediaInspectionCache;
  readonly downloader: MediaDownloaderPort;
}

export interface CreateDownloaderFeatureOptions extends DownloaderFeatureDependencies {
  /** Supplied only by the worker, which is the process that uploads files. */
  readonly sender?: TelegramMediaSenderPort;
  readonly cancellations: DownloadCancellationBus;
}

export function createDownloaderFeature(
  options: CreateDownloaderFeatureOptions,
): DownloaderFeature {
  const { config, db, redis, engine, clock, ids, logger } = options;

  const jobs = new DrizzleDownloadJobRepository(db, clock);
  const events = new DrizzleDownloadEventRepository(db, ids, clock, logger);
  const cache = new RedisMediaInspectionCache(redis, logger);
  const queue = new BullMqDownloadQueue(options.downloadQueue, logger);

  const accessPolicy = new DefaultDownloadAccessPolicy({
    jobs,
    redis,
    clock,
    logger,
    maxActiveJobsPerUser: config.limits.maxActiveJobsPerUser,
    inspectWindowMs: config.limits.rateLimitWindowMs,
    inspectMaxPerWindow: config.limits.inspectRateLimitMax,
  });

  const downloader = new EngineMediaDownloader(
    engine.engine,
    (url) => engine.registry.detect(url) !== undefined,
  );

  const inspectMedia = new InspectMediaUseCase({
    downloader,
    jobs,
    events,
    cache,
    accessPolicy,
    clock,
    ids,
    logger,
    cacheTtlSeconds: config.cache.mediaInfoTtlSeconds,
    selectionTtlSeconds: config.cache.selectionTtlSeconds,
    resolveUrl: (rawUrl, signal) => resolveUrl(options, rawUrl, signal),
  });

  const requestDownload = new RequestDownloadUseCase({
    jobs,
    events,
    queue,
    accessPolicy,
    clock,
    logger,
  });

  const cancelDownload = new CancelDownloadUseCase({
    jobs,
    events,
    queue,
    cancellations: options.cancellations,
    clock,
    logger,
  });
  const getStatus = new GetDownloadStatusUseCase({ jobs });

  const cleanupExpired = new CleanupExpiredDownloadsUseCase({
    jobs,
    clock,
    logger,
    removeOrphanWorkspaces: (maxAgeMs) => engine.workspaces.removeOrphans(maxAgeMs),
    orphanMaxAgeMs: config.storage.orphanWorkspaceMaxAgeMs,
  });

  const processDownload = new ProcessDownloadUseCase({
    downloader,
    // The bot process never uploads, so it never needs a sender. Asking for one
    // it cannot use would force it to construct a Telegram API client it has no
    // business owning.
    sender: options.sender ?? unavailableSender(),
    jobs,
    events,
    clock,
    logger,
    jobTimeoutMs: config.timeouts.jobMs,
    maxUploadBytes: config.limits.maxUploadBytes,
    progress: {
      intervalMs: config.progress.intervalMs,
      minPercentDelta: config.progress.minPercentDelta,
    },
    buildCaption: (job, media) =>
      fa.deliveredCaption(job.mediaTitle ?? media.fileName, job.requestedQuality),
  });

  const composer = new Composer<AppContext>();
  composer.callbackQuery(
    DOWNLOAD_CALLBACK_PATTERN,
    createDownloadCallbackHandler({ requestDownload, cancelDownload, getStatus, cache }),
  );
  composer.on(['message:text', 'message:caption'], createLinkMessageHandler({ inspectMedia }));

  return {
    botFeature: { name: 'downloader', composer },
    processDownload,
    cleanupExpired,
    getStatus,
    jobs,
    cache,
    downloader,
  };
}

/**
 * Validate, resolve and normalise a link, then decide what may be written down.
 *
 * Lives here rather than in the use case because it is the point where the
 * engine's URL guard — infrastructure — meets a policy decision the product
 * owns: with `STORE_FULL_SOURCE_URL` off, only the query-free form is
 * persisted, because a query string can carry a signed token that outlives the
 * backup it lands in.
 */
async function resolveUrl(
  options: CreateDownloaderFeatureOptions,
  rawUrl: string,
  signal: AbortSignal | undefined,
): Promise<{ platform: MediaPlatform; storable: StorableUrl; requestUrl: string }> {
  // The URL guard is the one place the engine is called WITHOUT going through
  // `EngineMediaDownloader`, so its errors used to miss that adapter's code
  // map entirely: an `EngineError` fell through `toDownloadError` as
  // INTERNAL_ERROR, and every rejected link — an unsupported platform, a
  // blocked address, a malformed URL — reached the user as "something went
  // wrong, try again later". Mapping it here is what makes the specific
  // Persian messages reachable at all.
  let safe;
  try {
    safe = options.engine.urlGuard.parse(rawUrl);
  } catch (error: unknown) {
    throw toDomainError(error);
  }

  const resolved = await options.engine.redirectResolver
    .resolve(safe, signal)
    .catch((error: unknown) => {
      throw toDomainError(error);
    });

  return {
    platform: resolved.platform,
    // The canonical form, not what the user pasted: for YouTube that is the
    // bare `watch?v=<id>`, which is how playlist and timestamp context is kept
    // away from the extractor.
    requestUrl: resolved.requestUrl,
    storable: {
      sourceUrl: options.config.privacy.storeFullSourceUrl
        ? resolved.originalUrl
        : stripUrlQuery(resolved.originalUrl),
      normalizedUrl: resolved.normalizedUrl,
      normalizedUrlHash: hashUrl(resolved.normalizedUrl),
    },
  };
}

/**
 * A sender that refuses rather than a null that explodes later. Reaching it
 * means the bot process tried to upload, which is a wiring bug.
 */
function unavailableSender(): TelegramMediaSenderPort {
  return {
    send: () =>
      Promise.reject(
        new Error('No Telegram media sender is configured in this process (bot cannot upload).'),
      ),
  };
}
