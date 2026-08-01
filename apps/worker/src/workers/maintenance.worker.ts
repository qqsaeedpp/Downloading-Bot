import { describeError } from '@tgtools/shared';
import type { WorkerContainer } from '../container.js';

export interface MaintenanceLoop {
  stop(): void;
}

/**
 * Periodic housekeeping, run on a plain timer rather than through BullMQ.
 *
 * A repeatable queue job would give durable scheduling, which this does not
 * need: the work is idempotent, cheap, and losing a tick costs nothing because
 * the next one picks up whatever accumulated. A timer has no Redis keys to
 * leak and no repeat-key migration to get wrong.
 */
export function startMaintenanceLoop(container: WorkerContainer): MaintenanceLoop {
  const intervalMs = container.config.maintenance.intervalMs;
  let running = false;

  const tick = async (): Promise<void> => {
    // Skip rather than queue: an overlapping sweep would fight itself over the
    // same rows.
    if (running) return;
    running = true;
    try {
      await container.downloader.cleanupExpired.execute();
    } catch (error: unknown) {
      container.logger.error('maintenance sweep failed', { error: describeError(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  // One sweep at startup clears whatever a previous crash left behind, without
  // waiting a full interval for it.
  void tick();

  container.logger.info('maintenance loop started', { intervalMs });
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
