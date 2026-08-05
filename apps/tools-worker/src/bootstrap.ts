import { loadConfig } from '@tgtools/config';
import { PUBLIC_BOT_API_ROOT_LABEL } from '@tgtools/telegram';
import {
  bytesToMegabytes,
  describeError,
  healthCheck,
  installGracefulShutdown,
  startHealthServer,
} from '@tgtools/shared';
import { createToolsWorkerContainer } from './container.js';
import { probeToolchain, summariseToolchain } from './health/toolchain-probe.js';
import { buildToolsWorkerShutdownSteps } from './shutdown/tools-worker-shutdown-steps.js';
import { startToolsMaintenanceLoop } from './workers/maintenance.worker.js';
import { startToolWorkers } from './workers/tool.workers.js';

/**
 * The tools process.
 *
 * A third process beside the bot and the downloader worker, because image,
 * video and PDF work contends for a different resource than downloading does:
 * a fifty-page render and a 4K resize each want a core, where a download wants
 * bandwidth. Sharing the downloader's worker would mean one user's PDF delaying
 * everyone's videos.
 *
 * It owns a Telegram API client but never a Bot. Two processes long-polling the
 * same token steal each other's updates.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Refusing to start is the honest answer to being switched off. A process
  // that boots and drains no queues looks healthy to an orchestrator while
  // every user's job sits in Redis forever.
  if (!config.tools.enabled) {
    process.stderr.write(
      'tools-worker: TOOLS_ENABLED is false, so this process has nothing to do. ' +
        'Set TOOLS_ENABLED=true, or stop running this service.\n',
    );
    process.exit(78); // EX_CONFIG
  }

  const container = createToolsWorkerContainer(config);
  const { logger } = container;

  logger.info('starting tools worker', {
    node: process.version,
    workspaceDir: config.tools.workspaceDir,
    families: {
      image: config.tools.imageEnabled,
      video: config.tools.videoEnabled,
      pdf: config.tools.pdfEnabled,
      qr: config.tools.qrEnabled,
    },
  });

  // Echoed once so "why was my file refused" is answerable from the log rather
  // than by guessing which of several ceilings won. No token, and no URL that
  // could carry one.
  logger.info('tool delivery', {
    telegramApiRoot: config.telegram.apiRoot ?? PUBLIC_BOT_API_ROOT_LABEL,
    telegramLocalMode: config.telegram.useLocalApi,
    localFileRoots: config.telegram.localFileRoots,
    uploadLimitMb: Math.round(bytesToMegabytes(config.limits.maxUploadBytes)),
    imageMaxMb: Math.round(bytesToMegabytes(config.tools.image.maxInputBytes)),
    videoMaxMb: Math.round(bytesToMegabytes(config.tools.video.maxInputBytes)),
    pdfMaxMb: Math.round(bytesToMegabytes(config.tools.pdf.maxInputBytes)),
  });

  await container.workspaces.ensureRoot();

  // Every binary, probed once, before any queue is touched. A container missing
  // `pdftocairo` looks perfectly healthy right up until a user sends a PDF, at
  // which point the failure is a confusing ENOENT in one job's log rather than
  // an obvious error in the deployment's.
  const reports = await probeToolchain({
    ffmpegPath: config.binaries.ffmpeg,
    ffprobePath: config.binaries.ffprobe,
    workspaceDir: config.tools.workspaceDir,
    cwd: config.tools.workspaceDir,
  });

  if (!summariseToolchain(reports, logger)) {
    // Fatal rather than degraded. Unlike a missing cookie file there is no
    // reduced mode here: half the tools would accept work and fail every job,
    // which is worse than not accepting it.
    throw new Error(
      'one or more native dependencies are unusable; see the "toolchain component unusable" ' +
        'lines above. This is an image or deployment problem, not a user error.',
    );
  }

  const workers = startToolWorkers(container);
  if (workers.length === 0) {
    throw new Error(
      'TOOLS_ENABLED is true but every family is switched off, so no queue would be drained.',
    );
  }

  const maintenance = startToolsMaintenanceLoop(container);

  // A cancel tap lands in the bot process; this is how it reaches the ffmpeg
  // that is actually running.
  const unsubscribeCancellations = await container.cancellations.subscribeCancel((jobId) => {
    const wasRunning = container.running.cancel(jobId);
    if (!wasRunning) logger.debug('cancellation was for a job on another worker', { jobId });
  });

  const health = await startHealthServer({
    port: config.tools.healthPort,
    service: 'tools-worker',
    version: config.version,
    logger,
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
      // The binaries are NOT re-probed here. They are version checks that fork
      // processes, and running them every ten seconds would spend more CPU on
      // checking than on working. Startup is where they belong.
      healthCheck('workspace', () => container.workspaces.ensureRoot()),
    ],
  });

  installGracefulShutdown({
    logger,
    // Must exceed the drain grace period, or the deadline fires while jobs are
    // still being given their chance to finish.
    timeoutMs: config.queue.shutdownGraceMs + 30_000,
    steps: buildToolsWorkerShutdownSteps({
      container,
      workers,
      maintenance,
      health,
      unsubscribeCancellations,
    }),
  });
}

main().catch((error: unknown) => {
  // Nothing is wired yet, so there is no logger and no shutdown to run. Write
  // to stderr and let the orchestrator see the non-zero exit.
  process.stderr.write(`fatal: tools-worker failed to start: ${describeError(error)}\n`);
  process.exit(1);
});
