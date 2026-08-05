import type { Logger } from '@tgtools/shared';
import { OperationCancelledError } from '@tgtools/shared';

/**
 * The jobs this process is running right now, so a cancellation — or a
 * shutdown — can reach the work actually in flight.
 *
 * Without it, "cancel" means nothing more than a row update: ffmpeg keeps
 * decoding and pdftocairo keeps rasterising until the job timeout fires,
 * minutes later, on a worker whose whole purpose is CPU.
 *
 * It lives in the feature rather than in `apps/tools-worker`, where its
 * downloader counterpart sits, for one practical reason: the unit suite only
 * collects `packages/*` and `features/*`, so anything under `apps/` is
 * untestable by construction. The behaviours below — a cancel for another
 * replica's job, a retry replacing a stale controller — are exactly the ones
 * worth pinning.
 */
export class RunningToolJobs {
  readonly #controllers = new Map<string, AbortController>();

  constructor(private readonly logger: Logger) {}

  /**
   * A second `register` for the same id REPLACES the first.
   *
   * That is the retry case: an attempt whose controller was never released
   * leaves a stale entry, and keeping it would mean a later cancel aborts a
   * controller nothing is listening to while the live attempt runs on.
   */
  register(jobId: string): AbortController {
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);
    return controller;
  }

  release(jobId: string): void {
    this.#controllers.delete(jobId);
  }

  /** False when the job is not running here — another replica has it. */
  cancel(jobId: string): boolean {
    const controller = this.#controllers.get(jobId);
    if (controller === undefined) return false;
    controller.abort(new OperationCancelledError('Cancelled by the user'));
    this.logger.info('aborted a running tool job on request', { jobId });
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
