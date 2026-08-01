import type { Logger } from '@tgtools/shared';
import { formatBytes } from '@tgtools/shared';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import type { JobWorkspace } from './job-workspace.js';

/**
 * How often to weigh the workspace. Three seconds is not arbitrary: on a fast
 * link a ten-second interval let ~160 MB past the ceiling before the first
 * check ran. A `readdir` plus a handful of `stat`s costs nothing, so the tight
 * loop is free and it bounds the overshoot.
 */
const POLL_INTERVAL_MS = 3_000;

export interface SizeWatchdogOptions {
  readonly workspace: JobWorkspace;
  readonly maxBytes: number;
  readonly logger: Logger;
  /** Called when the ceiling is breached; wired to the job's abort scope. */
  readonly onExceeded: (error: EngineError) => void;
  readonly pollIntervalMs?: number;
}

export interface SizeWatchdog {
  stop(): void;
  /** Largest total observed. Useful for the failure message. */
  peakBytes(): number;
}

/**
 * The second half of the two-tier size limit.
 *
 * `--max-filesize` only fires when the extractor declared a size up front, and
 * Instagram, TikTok and every HLS stream declare nothing at all. Without this,
 * a single link can still fill the volume — which is how one multi-hour 4K
 * "full game" pull took an entire host down in the reference deployment.
 */
export function startSizeWatchdog(options: SizeWatchdogOptions): SizeWatchdog {
  const { workspace, maxBytes, logger, onExceeded } = options;
  const intervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  let stopped = false;
  let peak = 0;

  const timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      const used = await workspace.getSize();
      if (stopped) return;
      if (used > peak) peak = used;
      if (used <= maxBytes) return;

      stopped = true;
      clearInterval(timer);
      logger.warn('download exceeded the size ceiling; aborting', {
        jobId: workspace.jobId,
        usedBytes: used,
        maxBytes,
      });
      onExceeded(
        new EngineError(
          EngineFailureCode.MediaTooLarge,
          `Download grew past the ${formatBytes(maxBytes)} ceiling (reached ${formatBytes(used)})`,
          { context: { usedBytes: used, maxBytes } },
        ),
      );
    })();
  }, intervalMs);

  // Never hold the event loop open on the watchdog's account.
  timer.unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    peakBytes: () => peak,
  };
}
