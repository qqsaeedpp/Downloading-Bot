import type { HealthServer, ShutdownStep } from '@tgtools/shared';
import { OperationCancelledError, delay } from '@tgtools/shared';
import type { Worker } from 'bullmq';
import type { ToolsWorkerContainer } from '../container.js';
import type { ToolsMaintenanceLoop } from '../workers/maintenance.worker.js';

export interface ToolsWorkerShutdownInput {
  readonly container: ToolsWorkerContainer;
  readonly workers: readonly Worker<unknown>[];
  readonly maintenance: ToolsMaintenanceLoop;
  readonly health: HealthServer;
  readonly unsubscribeCancellations: () => Promise<void>;
}

/**
 * The tools worker's teardown.
 *
 * Same shape as the downloader's, and the grace period is the interesting step
 * for the same reason: a conversion that is 90% through deserves the chance to
 * finish, but waiting indefinitely means the orchestrator SIGKILLs the
 * container with a half-written file on the volume and a job still locked in
 * Redis.
 *
 * The one difference is that everything here is plural. Four queues have to
 * stop accepting work before ANY of them drains — pausing them one at a time
 * would let the image queue pick up a new job while the video queue was still
 * being asked to finish, and that new job would then be aborted seconds later.
 */
export function buildToolsWorkerShutdownSteps(
  input: ToolsWorkerShutdownInput,
): readonly ShutdownStep[] {
  const { container, workers, maintenance, health } = input;
  const graceMs = container.config.queue.shutdownGraceMs;

  return [
    {
      name: 'stop-accepting-jobs',
      // `false` keeps the current jobs running while refusing new ones. All
      // four at once, before the drain below.
      run: async () => {
        await Promise.all(workers.map(async (worker) => worker.pause(false)));
      },
    },
    {
      name: 'maintenance-loop',
      run: () => {
        maintenance.stop();
        return Promise.resolve();
      },
    },
    { name: 'cancellation-subscription', run: () => input.unsubscribeCancellations() },
    {
      name: 'drain-running-jobs',
      run: async () => {
        const deadline = Date.now() + graceMs;
        while (container.running.size > 0 && Date.now() < deadline) {
          container.logger.info('waiting for running tool jobs to finish', {
            remaining: container.running.size,
            msLeft: deadline - Date.now(),
          });
          await delay(1_000);
        }
        if (container.running.size > 0) {
          const aborted = container.running.abortAll(
            new OperationCancelledError('Tools worker is shutting down'),
          );
          container.logger.warn('aborted tool jobs that outlasted the grace period', { aborted });
          // A moment for the abort handlers to kill their child processes and
          // remove their workspaces before the connections close under them.
          // Without it, a killed ffmpeg leaves its partial output behind for
          // the maintenance sweep to find hours later.
          await delay(2_000);
        }
      },
    },
    {
      name: 'bullmq-workers',
      run: async () => {
        await Promise.all(workers.map(async (worker) => worker.close()));
      },
    },
    { name: 'health-server', run: () => health.close() },
    { name: 'redis-subscriber', run: () => container.redisSubscriber.close() },
    { name: 'redis', run: () => container.redis.close() },
    { name: 'database', run: () => container.database.close() },
  ];
}
