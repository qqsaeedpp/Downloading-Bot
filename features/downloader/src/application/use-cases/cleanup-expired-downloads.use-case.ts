import type { Clock, Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import type { DownloadJobRepository } from '../../domain/ports/download-job.repository.js';

export interface CleanupExpiredDownloadsDependencies {
  readonly jobs: DownloadJobRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Removes workspaces left behind by a crashed worker. */
  readonly removeOrphanWorkspaces: (maxAgeMs: number) => Promise<number>;
  readonly orphanMaxAgeMs: number;
  readonly batchSize?: number;
}

export interface CleanupSummary {
  readonly expiredJobs: number;
  readonly removedWorkspaces: number;
}

/**
 * Housekeeping, run on a timer by the worker.
 *
 * Two kinds of debris accumulate: cards whose buttons nobody ever pressed,
 * which would otherwise sit in `awaiting_selection` forever and count against
 * the user's limit; and job directories from a worker that was killed
 * mid-download, which the process-local cleanup could not reach because the
 * process was gone.
 */
export class CleanupExpiredDownloadsUseCase {
  constructor(private readonly deps: CleanupExpiredDownloadsDependencies) {}

  async execute(): Promise<CleanupSummary> {
    const { deps } = this;
    let expiredJobs = 0;
    let removedWorkspaces = 0;

    try {
      expiredJobs = await deps.jobs.expireStaleSelections(deps.clock.now(), deps.batchSize ?? 500);
    } catch (error: unknown) {
      // Maintenance failing must never take the worker with it.
      deps.logger.error('failed to expire stale selections', { error: describeError(error) });
    }

    try {
      removedWorkspaces = await deps.removeOrphanWorkspaces(deps.orphanMaxAgeMs);
    } catch (error: unknown) {
      deps.logger.error('failed to sweep orphaned workspaces', { error: describeError(error) });
    }

    if (expiredJobs > 0 || removedWorkspaces > 0) {
      deps.logger.info('maintenance sweep completed', { expiredJobs, removedWorkspaces });
    }
    return { expiredJobs, removedWorkspaces };
  }
}
