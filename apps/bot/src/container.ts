import type { AppConfig } from '@tgtools/config';
import type { DatabaseHandle } from '@tgtools/database';
import { createDatabase } from '@tgtools/database';
import type { EngineBundle } from '@tgtools/downloader-engine';
import { createDownloaderEngine } from '@tgtools/downloader-engine';
import type { DownloaderFeature } from '@tgtools/feature-downloader';
import { RedisCancellationBus, createDownloaderFeature } from '@tgtools/feature-downloader';
import type { DownloadJobPayload } from '@tgtools/feature-downloader';
import type { ToolJobPayload } from '@tgtools/tool-contracts';
import {
  BullMqToolQueue,
  DrizzleToolJobRepository,
  QUEUE_FOR_FAMILY,
  RedisToolSessionStore,
  RequestToolJobUseCase,
  createToolsFeature,
} from '@tgtools/feature-tools';
import type { UserRepository } from '@tgtools/feature-users';
import { DrizzleUserRepository, RegisterOrUpdateUserUseCase } from '@tgtools/feature-users';
import { createLogger } from '@tgtools/logger';
import type { RedisHandle } from '@tgtools/queue';
import { QueueName, createQueue, createRedis } from '@tgtools/queue';
import type { Clock, IdGenerator, Logger, ToolFamily } from '@tgtools/shared';
import { CryptoIdGenerator, SystemClock } from '@tgtools/shared';
import type { AppContext, BotFeature } from '@tgtools/telegram';
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
  /**
   * Exposed so bootstrap can report the toolchain. The bot only ever calls
   * `inspect` on it — every download happens in the worker.
   */
  readonly engine: EngineBundle;
  readonly users: UserRepository;
  readonly registerOrUpdateUser: RegisterOrUpdateUserUseCase;
  readonly downloader: DownloaderFeature;
  /**
   * Absent when `TOOLS_ENABLED` is false.
   *
   * Not built at all rather than built and hidden: constructing it opens four
   * BullMQ queues against Redis, and a downloader-only deployment should not
   * pay for a feature it has switched off.
   */
  readonly tools: BotFeature | undefined;
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
    // Kept identical to the worker's: the bot only inspects, but an engine
    // configured differently between the two processes is how "it listed the
    // qualities and then refused to download" happens.
    ffmpeg: { ...config.ffmpeg, fastDelivery: config.limits.videoFastDelivery },
    downloadDirectory: config.storage.downloadDir,
    cookiePaths: config.cookies,
    extraction: config.extraction,
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
    engine,
    users,
    registerOrUpdateUser,
    downloader,
    tools: createTools(config, redis, database, clock, ids, logger),
  };
}

/**
 * The tools feature, or nothing.
 *
 * The queues are opened here and only here: four `Queue` objects each hold a
 * Redis connection, so a deployment with `TOOLS_ENABLED=false` should not be
 * paying for them. Returning `undefined` rather than a disabled feature keeps
 * that decision in one place instead of in every handler.
 */
function createTools(
  config: AppConfig,
  redis: RedisHandle,
  database: DatabaseHandle,
  clock: Clock,
  ids: IdGenerator,
  logger: Logger,
): BotFeature | undefined {
  if (!config.tools.enabled) return undefined;

  const queues = Object.fromEntries(
    Object.entries(QUEUE_FOR_FAMILY).map(([family, name]) => [
      family,
      createQueue<ToolJobPayload>({ name, connection: redis.client, config }),
    ]),
  ) as Record<ToolFamily, Queue<ToolJobPayload>>;

  const repository = new DrizzleToolJobRepository(database.db, clock, ids);

  return createToolsFeature({
    config,
    sessions: new RedisToolSessionStore({
      redis: redis.client,
      // Scopes the key so a staging bot beside production — which is how this
      // is usually deployed — cannot read the other's conversations.
      botId: config.telegram.botToken.split(':')[0] ?? 'unknown',
      ttlSeconds: config.tools.sessionTtlSeconds,
    }),
    requestJob: new RequestToolJobUseCase({
      repository,
      queue: new BullMqToolQueue(queues),
      ids,
      clock,
      logger,
      maxActiveJobsPerUser: config.tools.maxActiveJobsPerUser,
      jobTimeoutMs: config.tools.jobTimeoutMs,
    }),
    ids,
    clock,
    logger,
  });
}
