import type { AppConfig } from '@tgtools/config';
import type { DatabaseHandle } from '@tgtools/database';
import { createDatabase } from '@tgtools/database';
import { createDownloaderEngine } from '@tgtools/downloader-engine';
import type { DownloaderFeature } from '@tgtools/feature-downloader';
import { RedisCancellationBus, createDownloaderFeature } from '@tgtools/feature-downloader';
import type { DownloadJobPayload } from '@tgtools/feature-downloader';
import type { UserRepository } from '@tgtools/feature-users';
import { DrizzleUserRepository, RegisterOrUpdateUserUseCase } from '@tgtools/feature-users';
import { createLogger } from '@tgtools/logger';
import type { RedisHandle } from '@tgtools/queue';
import { QueueName, createQueue, createRedis } from '@tgtools/queue';
import type { Clock, IdGenerator, Logger } from '@tgtools/shared';
import { CryptoIdGenerator, SystemClock } from '@tgtools/shared';
import type { AppContext } from '@tgtools/telegram';
import { createBot } from '@tgtools/telegram';
import type { Queue } from 'bullmq';
import type { Bot } from 'grammy';

export interface BotContainer {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly database: DatabaseHandle;
  readonly redis: RedisHandle;
  readonly downloadQueue: Queue<DownloadJobPayload>;
  readonly bot: Bot<AppContext>;
  readonly users: UserRepository;
  readonly registerOrUpdateUser: RegisterOrUpdateUserUseCase;
  readonly downloader: DownloaderFeature;
}

/**
 * The bot process's composition root.
 *
 * Everything is constructed here, in dependency order, and passed down by
 * reference. No module reaches for a singleton and nothing imports a live
 * connection, which is what makes each piece constructible a second time — with
 * a fake clock, an in-memory repository — inside a test.
 */
export function createBotContainer(config: AppConfig): BotContainer {
  const logger = createLogger({ config, service: 'bot' });
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();

  const database = createDatabase({ config, logger });
  const redis = createRedis({ config, logger, role: 'bot' });

  const downloadQueue = createQueue<DownloadJobPayload>({
    name: QueueName.MediaDownload,
    connection: redis.client,
    config,
  });

  // The bot builds an engine too, but only ever calls `inspect` on it: quality
  // menus need real metadata, and a metadata probe is a few seconds, not a few
  // minutes. Every actual download happens in the worker.
  const engine = createDownloaderEngine({
    binaries: {
      ytDlpPath: config.binaries.ytDlp,
      ffmpegPath: config.binaries.ffmpeg,
      ffprobePath: config.binaries.ffprobe,
    },
    limits: {
      maxDownloadBytes: config.limits.maxDownloadBytes,
      maxTranscodeBytes: config.limits.maxTranscodeBytes,
      minFreeDiskBytes: config.storage.minFreeDiskBytes,
      inspectTimeoutMs: config.timeouts.inspectMs,
      downloadTimeoutMs: config.timeouts.downloadMs,
      ffmpegTimeoutMs: config.timeouts.ffmpegMs,
      ffprobeTimeoutMs: config.timeouts.ffprobeMs,
    },
    ffmpeg: config.ffmpeg,
    downloadDirectory: config.storage.downloadDir,
    cookiePaths: config.cookies,
    idGenerator: ids,
    logger,
  });

  const users = new DrizzleUserRepository(database.db, ids, clock);
  const registerOrUpdateUser = new RegisterOrUpdateUserUseCase({ users, logger });

  const downloader = createDownloaderFeature({
    config,
    db: database.db,
    redis: redis.client,
    engine,
    clock,
    ids,
    logger,
    downloadQueue,
    // The bot only ever publishes cancellations; the worker is the side that
    // needs a dedicated subscriber connection.
    cancellations: new RedisCancellationBus({ publisher: redis.client, logger }),
  });

  const bot = createBot({ config, logger });

  return {
    config,
    logger,
    clock,
    ids,
    database,
    redis,
    downloadQueue,
    bot,
    users,
    registerOrUpdateUser,
    downloader,
  };
}
