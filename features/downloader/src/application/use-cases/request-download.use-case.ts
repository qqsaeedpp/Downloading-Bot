import type { Clock, Logger } from '@tgtools/shared';
import { redactUrl } from '@tgtools/shared';
import type { DownloadJob } from '../../domain/entities/download-job.js';
import { isSelectionStillValid } from '../../domain/entities/download-job.js';
import { DownloadJobStatus } from '../../domain/entities/job-status.js';
import { DownloadError } from '../../domain/errors/download-error.js';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import type { DownloadJobRepository } from '../../domain/ports/download-job.repository.js';
import type {
  DownloadAccessPolicy,
  DownloadEventRepository,
  DownloadQueuePort,
} from '../../domain/ports/supporting-ports.js';
import type { DownloadOption } from '../../domain/value-objects/download-option.js';
import { toQualityString } from '../../domain/value-objects/download-option.js';

export interface RequestDownloadCommand {
  readonly shortId: string;
  readonly optionId: string;
  readonly requestId: string;
  /** The person who tapped, which need not be the person who asked. */
  readonly actingUserId: string;
  readonly telegramUserId: number;
  readonly statusMessageId: number;
  /** Rebuilt from the cached media info by the caller. */
  readonly availableOptions: readonly DownloadOption[];
}

export interface RequestDownloadResult {
  readonly job: DownloadJob;
  readonly option: DownloadOption;
}

export interface RequestDownloadDependencies {
  readonly jobs: DownloadJobRepository;
  readonly events: DownloadEventRepository;
  readonly queue: DownloadQueuePort;
  readonly accessPolicy: DownloadAccessPolicy;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Turns a button tap into a queued job.
 *
 * Every guard here exists because the alternative was observed in the wild: a
 * card left open for a day, a second person tapping someone else's buttons in a
 * group, a double tap arriving twice, a user queueing ten downloads at once.
 */
export class RequestDownloadUseCase {
  constructor(private readonly deps: RequestDownloadDependencies) {}

  async execute(command: RequestDownloadCommand): Promise<RequestDownloadResult> {
    const { deps } = this;

    const job = await deps.jobs.findByShortId(command.shortId);
    if (job === undefined) throw DownloadError.selectionExpired();

    // Ownership, not just existence. In a group chat the card is visible to
    // everyone, and without this anyone could spend another person's quota.
    if (job.userId !== command.actingUserId) {
      throw new DownloadError(
        DownloadFailureCode.SelectionExpired,
        'This card belongs to another user',
      );
    }

    // Also rejects a replayed callback for a job that already ran: once the
    // status has moved past `awaiting_selection`, a second tap finds nothing to
    // do rather than starting a duplicate download.
    if (!isSelectionStillValid(job, deps.clock.now())) throw DownloadError.selectionExpired();

    const option = command.availableOptions.find((candidate) => candidate.id === command.optionId);
    if (option === undefined) {
      throw new DownloadError(
        DownloadFailureCode.FormatUnavailable,
        'The selected option is no longer offered',
      );
    }

    if (!(await deps.accessPolicy.canCreateDownload(job.userId))) {
      throw DownloadError.tooManyActiveJobs(await deps.accessPolicy.getActiveJobLimit(job.userId));
    }

    const selectionApplied = await deps.jobs.updateSelection({
      jobId: job.id,
      expectedVersion: job.version,
      mediaType: option.type,
      requestedQuality: toQualityString(option),
      requestedFormatId: option.formatId,
      expiresAt: job.expiresAt,
    });
    // Losing this race means another tap got there first — which is exactly the
    // double-tap case, and the right answer is to do nothing more.
    if (!selectionApplied) throw DownloadError.selectionExpired();

    await deps.jobs.attachStatusMessage(job.id, command.statusMessageId);

    const now = deps.clock.now();
    const queued = await deps.jobs.updateStatus({
      jobId: job.id,
      expectedVersion: job.version + 1,
      status: DownloadJobStatus.Queued,
      queuedAt: now,
    });
    if (!queued) throw DownloadError.selectionExpired();

    // Enqueued only after the row says `queued`. The other order leaves a
    // window in which the worker picks the job up, finds it still
    // `awaiting_selection`, and refuses it.
    await deps.queue.enqueue({
      jobId: job.id,
      requestId: command.requestId,
      telegram: {
        userId: command.telegramUserId,
        chatId: job.telegramChatId,
        statusMessageId: command.statusMessageId,
      },
      media: {
        sourceUrl: job.sourceUrl,
        platform: job.platform,
        type: option.type,
        quality: toQualityString(option),
        formatId: option.formatId,
        // The size shown on the button the user pressed. Travelling with the
        // job is what lets the worker decline an oversized download before it
        // starts, rather than after a gigabyte has already moved.
        estimatedBytes: option.estimatedBytes,
      },
    });

    await deps.events.record({
      jobId: job.id,
      eventType: 'queued',
      payload: { optionId: option.id, type: option.type, label: option.label },
    });

    deps.logger.info('download queued', {
      jobId: job.id,
      platform: job.platform,
      type: option.type,
      quality: option.label,
      url: redactUrl(job.normalizedUrl),
    });

    const refreshed = await deps.jobs.findById(job.id);
    return { job: refreshed ?? job, option };
  }
}
