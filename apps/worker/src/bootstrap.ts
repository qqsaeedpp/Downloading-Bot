import { access, constants } from 'node:fs/promises';
import { loadConfig } from '@tgtools/config';
import { assertEnumCovers } from '@tgtools/database';
import {
  ALL_MEDIA_PLATFORMS,
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
  });

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

main().catch((error: unknown) => {
  process.stderr.write(`fatal: worker failed to start: ${describeError(error)}\n`);
  process.exit(1);
});
