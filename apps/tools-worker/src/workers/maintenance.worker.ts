import { describeError } from '@tgtools/shared';
import type { ToolsWorkerContainer } from '../container.js';

export interface ToolsMaintenanceLoop {
  stop(): void;
}

/**
 * Periodic housekeeping, on a plain timer rather than through BullMQ.
 *
 * Same reasoning as the downloader's: the work is idempotent and cheap, losing
 * a tick costs nothing because the next one picks up whatever accumulated, and
 * a timer has no Redis keys to leak and no repeat-key migration to get wrong.
 *
 * Two sweeps, and the workspace one is the load-bearing half. Every job removes
 * its own workspace in a `finally`, but a container killed mid-render never
 * reaches that — and this worker's directories hold decoded video frames, so
 * the leak is measured in gigabytes per crash rather than kilobytes.
 */
export function startToolsMaintenanceLoop(container: ToolsWorkerContainer): ToolsMaintenanceLoop {
  const intervalMs = container.config.tools.maintenanceIntervalMs;
  const maxAgeMs = container.config.tools.orphanWorkspaceMaxAgeHours * 60 * 60 * 1000;
  let running = false;

  const tick = async (): Promise<void> => {
    // Skip rather than queue: two overlapping sweeps would fight over the same
    // rows and the same directories.
    if (running) return;
    running = true;
    try {
      // Age-bounded, so a workspace belonging to a job that is STILL RUNNING on
      // another replica is never removed out from under it. A render may take
      // half an hour; the default age is six times that.
      const removed = await container.workspaces.sweepOrphans(maxAgeMs);
      if (removed.length > 0) {
        container.logger.info('removed orphaned tool workspaces', { count: removed.length });
      }

      // Jobs a crash left mid-flight. Without this they sit in `processing`
      // forever, counting against their owner's active-job ceiling and locking
      // that user out of the tools entirely.
      const expired = await container.toolJobs.expireStale(container.clock.now(), 200);
      if (expired > 0) container.logger.info('expired stale tool jobs', { count: expired });
    } catch (error: unknown) {
      container.logger.error('tool maintenance sweep failed', { error: describeError(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  // One sweep at startup clears whatever the previous crash left behind,
  // without waiting a full interval for it.
  void tick();

  container.logger.info('tool maintenance loop started', { intervalMs, maxAgeMs });
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
