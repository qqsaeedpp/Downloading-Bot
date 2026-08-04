import { stat } from 'node:fs/promises';
import type { AppConfig } from '@tgtools/config';
import type { DatabaseHandle } from '@tgtools/database';
import { createDatabase } from '@tgtools/database';
import type { EngineBundle } from '@tgtools/downloader-engine';
import { createDownloaderEngine } from '@tgtools/downloader-engine';
import type { DownloadJobPayload, DownloaderFeature } from '@tgtools/feature-downloader';
import {
  GrammyMediaSender,
  RedisCancellationBus,
  createDownloaderFeature,
} from '@tgtools/feature-downloader';
import { createLogger } from '@tgtools/logger';
import type { RedisHandle } from '@tgtools/queue';
import { QueueName, createQueue, createRedis } from '@tgtools/queue';
import type { Clock, IdGenerator, Logger } from '@tgtools/shared';
import { CryptoIdGenerator, SystemClock } from '@tgtools/shared';
import { PUBLIC_BOT_API_ROOT, createTelegramApi } from '@tgtools/telegram';
import type { Queue } from 'bullmq';
import type { Api } from 'grammy';
import { RunningJobRegistry } from './job-registry.js';

export interface WorkerContainer {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly database: DatabaseHandle;
  readonly redis: RedisHandle;
  /** Separate connection: a client in subscriber mode accepts nothing else. */
  readonly redisSubscriber: RedisHandle;
  readonly downloadQueue: Queue<DownloadJobPayload>;
  readonly telegramApi: Api;
  readonly engine: EngineBundle;
  readonly downloader: DownloaderFeature;
  readonly cancellations: RedisCancellationBus;
  readonly running: RunningJobRegistry;
}

/**
 * The worker process's composition root.
 *
 * The worker owns a Telegram API client but no bot: it sends progress edits and
 * finished files, and must never poll for updates — two processes long-polling
 * the same token would steal each other's messages.
 */
export function createWorkerContainer(config: AppConfig): WorkerContainer {
  const logger = createLogger({ config, service: 'worker' });
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();

  const database = createDatabase({ config, logger });
  const redis = createRedis({ config, logger, role: 'worker' });
  const redisSubscriber = createRedis({ config, logger, role: 'worker-subscriber' });

  const downloadQueue = createQueue<DownloadJobPayload>({
    name: QueueName.MediaDownload,
    connection: redis.client,
    config,
  });

  const telegramApi = createTelegramApi({ config });

  const engine = createDownloaderEngine({
    binaries: {
      ytDlpPath: config.binaries.ytDlp,
      ffmpegPath: config.binaries.ffmpeg,
      ffprobePath: config.binaries.ffprobe,
      jsRuntimePath: config.binaries.jsRuntime,
    },
    limits: {
      maxDownloadBytes: config.limits.maxDownloadBytes,
      maxTranscodeBytes: config.limits.maxTranscodeBytes,
      // Lets the normalizer decline a re-encode whose output could not be
      // delivered anyway; it is not a download limit.
      maxUploadBytes: config.limits.maxUploadBytes,
      minFreeDiskBytes: config.storage.minFreeDiskBytes,
      inspectTimeoutMs: config.timeouts.inspectMs,
      downloadTimeoutMs: config.timeouts.downloadMs,
      ffmpegTimeoutMs: config.timeouts.ffmpegMs,
      ffprobeTimeoutMs: config.timeouts.ffprobeMs,
    },
    // `fastDelivery` lives under `limits`, not `ffmpeg`, because it is a policy
    // about what to spend, not an encoder setting. Spreading it in here is what
    // makes VIDEO_FAST_DELIVERY=false actually reach the normalizer — without
    // it the engine fell back to its own `?? true` and the variable was inert.
    ffmpeg: { ...config.ffmpeg, fastDelivery: config.limits.videoFastDelivery },
    downloadDirectory: config.storage.downloadDir,
    cookiePaths: config.cookies,
    extraction: config.extraction,
    idGenerator: ids,
    logger,
  });

  const cancellations = new RedisCancellationBus({
    publisher: redis.client,
    subscriber: redisSubscriber.client,
    logger,
  });

  const downloader = createDownloaderFeature({
    config,
    db: database.db,
    redis: redis.client,
    engine,
    clock,
    ids,
    logger,
    downloadQueue,
    cancellations,
    sender: new GrammyMediaSender({
      api: telegramApi,
      logger,
      uploadTimeoutMs: config.timeouts.uploadMs,
      maxUploadBytes: config.limits.maxUploadBytes,
      apiRoot: config.telegram.apiRoot ?? PUBLIC_BOT_API_ROOT,
      statFile: (path) => stat(path),
    }),
  });

  return {
    config,
    logger,
    clock,
    ids,
    database,
    redis,
    redisSubscriber,
    downloadQueue,
    telegramApi,
    engine,
    downloader,
    cancellations,
    running: new RunningJobRegistry(logger),
  };
}
