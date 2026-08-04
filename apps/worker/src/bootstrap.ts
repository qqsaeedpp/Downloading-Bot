import { access, constants } from 'node:fs/promises';
import { loadConfig } from '@tgtools/config';
import {
  describePotProviderProblem,
  probePotProvider,
  reportCookieAccess,
} from '@tgtools/downloader-engine';
import { PUBLIC_BOT_API_ROOT_LABEL } from '@tgtools/telegram';
import { assertEnumCovers } from '@tgtools/database';
import type { Logger } from '@tgtools/shared';
import {
  ALL_MEDIA_PLATFORMS,
  bytesToMegabytes,
  describeError,
  healthCheck,
  installGracefulShutdown,
  startHealthServer,
} from '@tgtools/shared';
import { createWorkerContainer } from './container.js';
import { buildWorkerShutdownSteps } from './shutdown/worker-shutdown-steps.js';
import { startDownloadWorker } from './workers/download.worker.js';
import { startMaintenanceLoop } from './workers/maintenance.worker.js';

/**
 * The worker process.
 *
 * This is where everything expensive happens: yt-dlp, FFmpeg, disk I/O and the
 * upload. Keeping it out of the bot is what stops one slow 400 MB download from
 * blocking every other user's `/start`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createWorkerContainer(config);
  const { logger } = container;

  // Versions in the startup log, so a bug report says which yt-dlp produced the
  // behaviour. Extractors change weekly; "it worked last Tuesday" is otherwise
  // unfalsifiable.
  const toolchain = await container.engine.engine.probeToolchain();
  // `version` and `env` already ride on every line via the logger's base
  // bindings; repeating them here would emit a duplicated JSON key.
  logger.info('starting worker', {
    node: process.version,
    ytDlp: toolchain.ytDlpVersion ?? 'unknown',
    ffmpeg: toolchain.ffmpegVersion ?? 'unknown',
    ffprobe: toolchain.ffprobeVersion ?? 'unknown',
    jsRuntime: toolchain.jsRuntimeVersion ?? 'MISSING',
  });

  warnIfNoJsRuntime(logger, toolchain.jsRuntimeVersion);

  // The delivery settings, echoed once so "why did my 400 MB file get refused"
  // is answerable from the log rather than by guessing which of two spellings of
  // the upload ceiling won. No token, and no URL that could carry one.
  logger.info('telegram delivery', {
    telegramApiRoot: config.telegram.apiRoot ?? PUBLIC_BOT_API_ROOT_LABEL,
    telegramLocalMode: config.telegram.useLocalApi,
    telegramUploadLimitMb: Math.round(bytesToMegabytes(config.limits.maxUploadBytes)),
    videoFastDelivery: config.limits.videoFastDelivery,
    maxTranscodeMb: Math.round(bytesToMegabytes(config.limits.maxTranscodeBytes)),
  });

  // Verified at startup, not on the first user's link. "I set the variable and
  // it still says bot check" has two completely different causes -- the provider
  // is unreachable, or it answered and was not enough -- and only one of them is
  // worth more of the operator's evening.
  const potStatus = await probePotProvider(config.extraction.potProviderUrl);
  logger.info('PO token provider', { status: potStatus.kind });
  const potProblem = describePotProviderProblem(potStatus);
  if (potProblem !== undefined) logger.error(potProblem);

  // Read now, not on the first job that needs one. The bot and the worker mount
  // their cookies separately, and the way that divergence surfaces otherwise is
  // a video that lists every quality and then fails the moment a user picks one.
  const cookieReports = await reportCookieAccess(config.cookies, logger);
  if (cookieReports.length > 0) {
    logger.info('cookie files', {
      cookies: Object.fromEntries(cookieReports.map((r) => [r.platform, r.kind])),
    });
  }

  if (toolchain.ytDlpVersion === undefined) {
    // Fail loudly at startup rather than on the first user's download.
    throw new Error(
      `yt-dlp is not usable at "${config.binaries.ytDlp}". Check YTDLP_PATH and the image build.`,
    );
  }

  await container.engine.workspaces.ensureWritable();

  const worker = startDownloadWorker(container);
  const maintenance = startMaintenanceLoop(container);

  // A cancellation tap lands in the bot process; this is how it reaches the
  // yt-dlp that is actually running.
  const unsubscribeCancellations = await container.cancellations.subscribeCancel((jobId) => {
    const wasRunning = container.running.cancel(jobId);
    if (!wasRunning) logger.debug('cancellation was for a job on another worker', { jobId });
  });

  const health = await startHealthServer({
    port: config.health.workerPort,
    service: 'worker',
    version: config.version,
    logger,
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
      healthCheck('platform-enum', () =>
        assertEnumCovers(container.database.db, 'media_platform', ALL_MEDIA_PLATFORMS),
      ),
      healthCheck('yt-dlp', () => assertExecutable(config.binaries.ytDlp)),
      healthCheck('ffmpeg', () => assertExecutable(config.binaries.ffmpeg)),
      healthCheck('ffprobe', () => assertExecutable(config.binaries.ffprobe)),
      healthCheck('download-dir', () => container.engine.workspaces.ensureWritable()),
    ],
  });

  installGracefulShutdown({
    logger,
    // Must exceed the drain grace period, or the deadline fires while jobs are
    // still being given their chance to finish.
    timeoutMs: config.queue.shutdownGraceMs + 30_000,
    steps: buildWorkerShutdownSteps({
      container,
      worker,
      maintenance,
      health,
      unsubscribeCancellations,
    }),
  });
}

async function assertExecutable(path: string): Promise<void> {
  await access(path, constants.X_OK);
}

/**
 * Loud, but not fatal.
 *
 * Since yt-dlp 2025.11.12 a JavaScript runtime is required to solve YouTube's
 * player challenge; without one the format list comes back empty or heavily
 * reduced, which is indistinguishable from a post that has no media. It affects
 * exactly one platform, though, so refusing to start would take the other four
 * down with it.
 */
export function warnIfNoJsRuntime(logger: Logger, version: string | undefined): void {
  if (version !== undefined) return;
  logger.error(
    'no JavaScript runtime found — YouTube extraction will return few formats or none. ' +
      'Install Deno (the images do this via the DENO_VERSION build arg) or set DENO_PATH. ' +
      'Every other platform is unaffected.',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: worker failed to start: ${describeError(error)}\n`);
  process.exit(1);
});
