import type { AppConfig } from '@tgtools/config';
import type { DatabaseHandle } from '@tgtools/database';
import { createDatabase } from '@tgtools/database';
import {
  FfmpegVideoProcessor,
  NodeQrGenerator,
  PopplerPdfProcessor,
  SharpImageProcessor,
  ToolWorkspaceManager,
} from '@tgtools/file-tools-engine';
import { createLogger } from '@tgtools/logger';
import type { RedisHandle } from '@tgtools/queue';
import { createRedis } from '@tgtools/queue';
import type { Clock, IdGenerator, Logger } from '@tgtools/shared';
import { CryptoIdGenerator, SystemClock } from '@tgtools/shared';
import { createTelegramApi } from '@tgtools/telegram';
import type { Api } from 'grammy';

/**
 * The tools worker's composition root.
 *
 * A third process, beside the bot and the downloader worker. It exists because
 * image, video and PDF work is CPU- and memory-hungry in a way downloading is
 * not: a 4K image resize and a PDF render both want a core to themselves, and
 * sharing the downloader's worker would mean one user's fifty-page render
 * delaying everyone's video downloads.
 *
 * It owns a Telegram API client but never a Bot: only `apps/bot` may receive
 * updates. Two processes long-polling the same token steal each other's
 * messages.
 */
export interface ToolsWorkerContainer {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly database: DatabaseHandle;
  readonly redis: RedisHandle;
  /** Separate connection: a client in subscriber mode accepts nothing else. */
  readonly redisSubscriber: RedisHandle;
  readonly telegramApi: Api;
  readonly workspaces: ToolWorkspaceManager;
  readonly image: SharpImageProcessor;
  readonly video: FfmpegVideoProcessor;
  readonly pdf: PopplerPdfProcessor;
  readonly qr: NodeQrGenerator;
}

export function createToolsWorkerContainer(config: AppConfig): ToolsWorkerContainer {
  const logger = createLogger({ config, service: 'tools-worker' });
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();

  const database = createDatabase({ config, logger });
  const redis = createRedis({ config, logger, role: 'tools-worker' });
  const redisSubscriber = createRedis({ config, logger, role: 'tools-worker-subscriber' });

  const tools = config.tools;

  const workspaces = new ToolWorkspaceManager({
    rootDir: tools.workspaceDir,
    minFreeDiskBytes: tools.minFreeDiskBytes,
  });

  return {
    config,
    logger,
    clock,
    ids,
    database,
    redis,
    redisSubscriber,
    telegramApi: createTelegramApi({ config }),
    workspaces,

    image: new SharpImageProcessor({
      limits: {
        maxPixels: tools.image.maxPixels,
        maxDimension: tools.image.maxDimension,
        maxInputBytes: tools.image.maxInputBytes,
      },
    }),

    video: new FfmpegVideoProcessor({
      // The same binaries the downloader uses. Sharing the paths rather than
      // introducing a second pair means one image build to keep correct.
      ffmpegPath: config.binaries.ffmpeg,
      ffprobePath: config.binaries.ffprobe,
      limits: {
        maxInputBytes: tools.video.maxInputBytes,
        maxDurationSeconds: tools.video.maxDurationSeconds,
      },
      // Lets an MP3 that could never be delivered be refused from its DURATION,
      // in milliseconds, rather than after a full extraction.
      maxOutputBytes: config.limits.maxUploadBytes,
    }),

    pdf: new PopplerPdfProcessor({
      pdfinfoPath: 'pdfinfo',
      pdftocairoPath: 'pdftocairo',
      limits: {
        maxPages: tools.pdf.maxPages,
        maxImages: tools.pdf.maxImages,
        maxInputBytes: tools.pdf.maxInputBytes,
      },
    }),

    qr: new NodeQrGenerator({ maxPayloadBytes: tools.qr.maxInputBytes }),
  };
}
