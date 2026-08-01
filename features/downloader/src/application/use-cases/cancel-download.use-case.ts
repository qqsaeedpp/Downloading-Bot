import type { Clock, Logger } from '@tgtools/shared';
import { isJobActive } from '../../domain/entities/download-job.js';
import { DownloadJobStatus } from '../../domain/entities/job-status.js';
import { DownloadError } from '../../domain/errors/download-error.js';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import type { DownloadJobRepository } from '../../domain/ports/download-job.repository.js';
import type {
  DownloadCancellationBus,
  DownloadEventRepository,
  DownloadQueuePort,
} from '../../domain/ports/supporting-ports.js';

export interface CancelDownloadCommand {
  readonly shortId: string;
  readonly actingUserId: string;
}

export interface CancelDownloadDependencies {
  readonly jobs: DownloadJobRepository;
  readonly events: DownloadEventRepository;
  readonly queue: DownloadQueuePort;
  readonly cancellations: DownloadCancellationBus;
  readonly clock: Clock;
  readonly logger: Logger;
}

export type CancelOutcome = 'cancelled' | 'already-finished';

/**
 * Cancellation has two halves, and both are needed.
 *
 * Marking the row `cancelled` stops anything that has not started; removing the
 * queue entry stops anything that has been queued but not picked up. A job
 * already running in a worker is stopped by that worker noticing the status
 * change on its next checkpoint — the abort signal reaches it through the
 * process that owns the download, not from here.
 */
export class CancelDownloadUseCase {
  constructor(private readonly deps: CancelDownloadDependencies) {}

  async execute(command: CancelDownloadCommand): Promise<CancelOutcome> {
    const { deps } = this;

    const job = await deps.jobs.findByShortId(command.shortId);
    if (job === undefined) throw DownloadError.selectionExpired();
    if (job.userId !== command.actingUserId) {
      throw new DownloadError(
        DownloadFailureCode.SelectionExpired,
        'This card belongs to another user',
      );
    }

    if (!isJobActive(job)) return 'already-finished';

    const applied = await deps.jobs.updateStatus({
      jobId: job.id,
      expectedVersion: job.version,
      status: DownloadJobStatus.Cancelled,
      errorCode: DownloadFailureCode.JobCancelled,
      failedAt: deps.clock.now(),
    });
    // Lost the race against the worker finishing. That is a perfectly good
    // outcome for the user — the file arrived — so it is not an error.
    if (!applied) return 'already-finished';

    // Both halves are needed: `remove` takes care of a job still waiting in the
    // queue, and the broadcast reaches the worker that already picked one up
    // and is holding a live yt-dlp process.
    await deps.queue.remove(job.id);
    await deps.cancellations.publishCancel(job.id);
    await deps.events.record({ jobId: job.id, eventType: 'cancelled', payload: {} });
    deps.logger.info('download cancelled by user', { jobId: job.id });
    return 'cancelled';
  }
}
