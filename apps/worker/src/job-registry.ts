import type { Logger } from '@tgtools/shared';
import { OperationCancelledError } from '@tgtools/shared';

/**
 * Tracks the jobs this worker is currently running so that a cancellation — or
 * a shutdown — can reach the process actually doing the work.
 *
 * Without this, "cancel" would mean nothing more than a row update: yt-dlp
 * would keep pulling bytes and FFmpeg would keep burning CPU until the job
 * timeout fired, minutes later.
 */
export class RunningJobRegistry {
  readonly #controllers = new Map<string, AbortController>();

  constructor(private readonly logger: Logger) {}

  register(jobId: string): AbortController {
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);
    return controller;
  }

  release(jobId: string): void {
    this.#controllers.delete(jobId);
  }

  /** Returns false when the job is not running here — another replica has it. */
  cancel(jobId: string): boolean {
    const controller = this.#controllers.get(jobId);
    if (controller === undefined) return false;
    controller.abort(new OperationCancelledError('Cancelled by the user'));
    this.logger.info('aborted a running job on request', { jobId });
    return true;
  }

  /** Used by shutdown once the grace period has run out. */
  abortAll(reason: Error): number {
    const count = this.#controllers.size;
    for (const controller of this.#controllers.values()) controller.abort(reason);
    this.#controllers.clear();
    return count;
  }

  get size(): number {
    return this.#controllers.size;
  }
}
