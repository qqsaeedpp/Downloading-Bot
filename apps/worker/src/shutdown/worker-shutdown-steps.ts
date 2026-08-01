import type { HealthServer, ShutdownStep } from '@tgtools/shared';
import { OperationCancelledError, delay } from '@tgtools/shared';
import type { Worker } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import type { MaintenanceLoop } from '../workers/maintenance.worker.js';

export interface WorkerShutdownInput {
  readonly container: WorkerContainer;
  readonly worker: Worker<unknown>;
  readonly maintenance: MaintenanceLoop;
  readonly health: HealthServer;
  readonly unsubscribeCancellations: () => Promise<void>;
}

/**
 * The worker's teardown.
 *
 * The interesting step is the grace period. A download that is 90% through
 * deserves the chance to finish — the user is watching a progress bar — but
 * waiting indefinitely means the orchestrator SIGKILLs the container with a
 * half-written file on the volume and a job still locked in Redis. So: stop
 * taking new work, wait a bounded time, then abort what is left so it fails
 * cleanly, releases its lock and deletes its workspace.
 */
export function buildWorkerShutdownSteps(input: WorkerShutdownInput): readonly ShutdownStep[] {
  const { container, worker, maintenance, health } = input;
  const graceMs = container.config.queue.shutdownGraceMs;

  return [
    {
      name: 'stop-accepting-jobs',
      // `false` keeps the current jobs running while refusing new ones.
      run: () => worker.pause(false),
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
          container.logger.info('waiting for running jobs to finish', {
            remaining: container.running.size,
            msLeft: deadline - Date.now(),
          });
          await delay(1_000);
        }
        if (container.running.size > 0) {
          const aborted = container.running.abortAll(
            new OperationCancelledError('Worker is shutting down'),
          );
          container.logger.warn('aborted jobs that outlasted the grace period', { aborted });
          // A moment for the abort handlers to kill their child processes and
          // remove their workspaces before the connections close under them.
          await delay(2_000);
        }
      },
    },
    { name: 'bullmq-worker', run: () => worker.close() },
    { name: 'health-server', run: () => health.close() },
    { name: 'download-queue', run: () => container.downloadQueue.close() },
    { name: 'redis-subscriber', run: () => container.redisSubscriber.close() },
    { name: 'redis', run: () => container.redis.close() },
    { name: 'database', run: () => container.database.close() },
  ];
}
