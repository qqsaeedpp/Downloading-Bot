import { DownloadStage } from '@tgtools/shared';
import type { Clock, DownloadProgress, Logger } from '@tgtools/shared';
import {
  createAbortScope,
  describeError,
  isCancellation,
  truncateForStorage,
} from '@tgtools/shared';
import type { DownloadJob } from '../../domain/entities/download-job.js';
import { DownloadJobStatus } from '../../domain/entities/job-status.js';
import { DownloadError, toDownloadError } from '../../domain/errors/download-error.js';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import type { DownloadJobRepository } from '../../domain/ports/download-job.repository.js';
import type {
  DownloadedMedia,
  MediaDownloaderPort,
} from '../../domain/ports/media-downloader.port.js';
import type {
  DownloadEventRepository,
  DownloadJobPayload,
  DownloadProgressReporter,
  TelegramMediaSenderPort,
} from '../../domain/ports/supporting-ports.js';
import { ProgressThrottler } from '../services/progress-throttler.js';

export interface ProcessDownloadDependencies {
  readonly downloader: MediaDownloaderPort;
  readonly sender: TelegramMediaSenderPort;
  readonly jobs: DownloadJobRepository;
  readonly events: DownloadEventRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly jobTimeoutMs: number;
  readonly maxUploadBytes: number;
  readonly progress: { readonly intervalMs: number; readonly minPercentDelta: number };
  /** Builds the caption. Presentation supplies it so the use case stays language-free. */
  readonly buildCaption: (job: DownloadJob, media: DownloadedMedia) => string;
}

export interface ProcessDownloadCommand {
  readonly payload: DownloadJobPayload;
  readonly reporter: DownloadProgressReporter;
  /** Fires when the worker is shutting down or the job was cancelled. */
  readonly signal: AbortSignal;
}

export type ProcessDownloadOutcome = 'completed' | 'skipped' | 'cancelled';

/**
 * The whole download pipeline, from queue message to delivered file.
 *
 * The shape is dictated by two things that go wrong in production: BullMQ can
 * deliver the same job twice, and a worker can die halfway through. So the
 * first thing this does is re-read the row and decide whether the work is still
 * wanted, and the last thing it does — on every path, including failure and
 * cancellation — is delete the workspace.
 */
export class ProcessDownloadUseCase {
  constructor(private readonly deps: ProcessDownloadDependencies) {}

  async execute(command: ProcessDownloadCommand): Promise<ProcessDownloadOutcome> {
    const { deps } = this;
    const { payload, reporter } = command;
    const logger = deps.logger.child({
      jobId: payload.jobId,
      requestId: payload.requestId,
      platform: payload.media.platform,
    });

    const job = await deps.jobs.findById(payload.jobId);
    if (job === undefined) {
      // The row is the source of truth; a queue message without one is debris
      // from a deleted user or a wiped database.
      logger.warn('queue delivered a job with no database row; discarding');
      return 'skipped';
    }

    // Idempotency. A redelivery of a finished job must not download the file a
    // second time, and must not overwrite the result the user already has.
    if (job.status === DownloadJobStatus.Completed) {
      logger.info('job already completed; ignoring redelivery');
      return 'skipped';
    }
    if (job.status === DownloadJobStatus.Cancelled || job.status === DownloadJobStatus.Expired) {
      logger.info('job is no longer wanted', { status: job.status });
      return 'skipped';
    }

    /**
     * The version this worker believes it holds.
     *
     * Tracked in one place and advanced by {@link #advance} rather than written
     * as `job.version + 1`, `+ 2` at each call site: the arithmetic form silently
     * breaks the moment a step is inserted, and the failure it produces — a
     * rejected conditional write, deep in the pipeline — looks nothing like the
     * mistake that caused it.
     */
    let version = job.version;

    const claimed = await deps.jobs.updateStatus({
      jobId: job.id,
      expectedVersion: version,
      status: DownloadJobStatus.Downloading,
      startedAt: deps.clock.now(),
      incrementAttempt: true,
    });
    if (!claimed) {
      // Another worker won the claim, or the user cancelled between the read
      // and the write. Either way this delivery has nothing left to do.
      logger.info('could not claim the job; another actor moved it first');
      return 'skipped';
    }
    version += 1;

    const scope = createAbortScope({
      parent: command.signal,
      timeoutMs: deps.jobTimeoutMs,
      label: 'download-job',
    });
    let media: DownloadedMedia | undefined;

    try {
      await reporter.onStage(DownloadStage.Downloading);
      media = await this.#download(payload, reporter, scope.signal);

      // The file exists; from here on the work is local. Recorded as its own
      // state — rather than folded into `downloading` — because it is the phase
      // that can take minutes on a large re-encode, and an operator looking at
      // a stuck job needs to know which half it is stuck in.
      version = await this.#advance(job.id, version, DownloadJobStatus.Processing);

      this.#assertDeliverable(media);

      version = await this.#advance(job.id, version, DownloadJobStatus.Uploading);
      await reporter.onStage(DownloadStage.Uploading);

      const sent = await deps.sender.send({
        chatId: payload.telegram.chatId,
        filePath: media.filePath,
        fileName: media.fileName,
        mimeType: media.mimeType,
        fileSize: media.fileSize,
        caption: deps.buildCaption(job, media),
        type: payload.media.type,
        video: media.video,
        signal: scope.signal,
      });

      await deps.jobs.updateOutput({
        jobId: job.id,
        outputSize: media.fileSize,
        outputMimeType: media.mimeType,
        outputFileId: sent.fileId,
      });
      version = await this.#advance(job.id, version, DownloadJobStatus.Completed, {
        completedAt: deps.clock.now(),
      });
      await deps.events.record({
        jobId: job.id,
        eventType: 'completed',
        payload: { bytes: media.fileSize, mimeType: media.mimeType },
      });
      await reporter.onCompleted({ fileSize: media.fileSize, fileName: media.fileName });

      logger.info('job completed', { bytes: media.fileSize });
      return 'completed';
    } catch (error: unknown) {
      const outcome = await this.#handleFailure(
        job,
        version,
        error,
        reporter,
        logger,
        command.signal,
      );
      if (outcome === 'rethrow') throw toDownloadError(error);
      return outcome;
    } finally {
      scope.dispose();
      // Unconditional. The workspace is deleted whether the job succeeded,
      // failed, timed out or was cancelled — anything less accumulates on a
      // shared volume until the disk is gone.
      await media?.cleanup();
    }
  }

  /**
   * Move the job on and return the version it now holds.
   *
   * A rejected write means somebody else changed the row — a cancellation, or a
   * second worker — so the job is no longer ours to finish and continuing would
   * deliver a file the user already declined.
   */
  async #advance(
    jobId: string,
    expectedVersion: number,
    status: DownloadJobStatus,
    extra: { completedAt?: Date } = {},
  ): Promise<number> {
    const applied = await this.deps.jobs.updateStatus({
      jobId,
      expectedVersion,
      status,
      ...(extra.completedAt === undefined ? {} : { completedAt: extra.completedAt }),
    });
    if (!applied) {
      throw new DownloadError(
        DownloadFailureCode.JobCancelled,
        `Job moved on beneath us while entering "${status}"`,
        { context: { jobId, expectedVersion, status } },
      );
    }
    return expectedVersion + 1;
  }

  async #download(
    payload: DownloadJobPayload,
    reporter: DownloadProgressReporter,
    signal: AbortSignal,
  ): Promise<DownloadedMedia> {
    const throttler = new ProgressThrottler({
      clock: this.deps.clock,
      minIntervalMs: this.deps.progress.intervalMs,
      minPercentDelta: this.deps.progress.minPercentDelta,
    });

    return this.deps.downloader.download(
      {
        url: payload.media.sourceUrl,
        platform: payload.media.platform,
        type: payload.media.type,
        quality: payload.media.quality,
        formatId: payload.media.formatId,
      },
      {
        signal,
        onProgress: async (progress: DownloadProgress) => {
          // The database write is cheap and unconditional; the Telegram edit is
          // neither, so only that one goes through the throttler.
          await this.deps.jobs.updateProgress({
            jobId: payload.jobId,
            progressPercent: Math.round(progress.percent ?? 0),
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
          });
          if (throttler.shouldEmit(progress)) await reporter.onProgress(progress);
        },
        onStageChange: async (stage) => {
          throttler.reset();
          if (stage === DownloadStage.Normalizing) {
            await this.deps.jobs.updateProgress({
              jobId: payload.jobId,
              progressPercent: 100,
              downloadedBytes: 0,
              totalBytes: undefined,
            });
          }
          await reporter.onStage(stage);
        },
      },
    );
  }

  /**
   * The download ceiling and the upload ceiling are different numbers, and a
   * file can clear the first and fail the second. Catching that here — before
   * spending minutes streaming to Telegram — turns a confusing 413 into a
   * precise message.
   */
  #assertDeliverable(media: DownloadedMedia): void {
    if (media.fileSize <= this.deps.maxUploadBytes) return;
    // No cleanup here: the `finally` in `execute` owns that, on every path.
    throw new DownloadError(
      DownloadFailureCode.MediaTooLarge,
      `Produced file is ${media.fileSize} bytes, over the ${this.deps.maxUploadBytes} byte upload ceiling`,
      { context: { fileSize: media.fileSize, maxUploadBytes: this.deps.maxUploadBytes } },
    );
  }

  async #handleFailure(
    job: DownloadJob,
    version: number,
    error: unknown,
    reporter: DownloadProgressReporter,
    logger: Logger,
    workerSignal: AbortSignal,
  ): Promise<ProcessDownloadOutcome | 'rethrow'> {
    const downloadError = toDownloadError(error);
    const cancelled =
      isCancellation(error) ||
      downloadError.code === DownloadFailureCode.JobCancelled ||
      workerSignal.aborted;

    if (cancelled) {
      logger.info('job stopped before completion', { reason: downloadError.code });
      await this.deps.jobs.updateStatus({
        jobId: job.id,
        expectedVersion: version,
        status: DownloadJobStatus.Cancelled,
        errorCode: DownloadFailureCode.JobCancelled,
        failedAt: this.deps.clock.now(),
      });
      return 'cancelled';
    }

    logger.error('job failed', {
      code: downloadError.code,
      retryable: downloadError.retryable,
      error: describeError(error),
    });

    await this.deps.events.record({
      jobId: job.id,
      eventType: 'failed',
      // The code and a bounded summary — never the raw tool output, which
      // echoes request URLs and would put a session token in the database.
      payload: {
        code: downloadError.code,
        message: truncateForStorage(downloadError.message, 300),
      },
    });

    if (downloadError.retryable) {
      // Leave the row in `downloading` and let BullMQ's backoff bring it back.
      // Writing `failed` here would make a retryable job look final to the user
      // and to the maintenance sweep.
      return 'rethrow';
    }

    await this.deps.jobs.updateStatus({
      jobId: job.id,
      expectedVersion: version,
      status: DownloadJobStatus.Failed,
      errorCode: downloadError.code,
      errorMessageSafe: truncateForStorage(downloadError.message, 300),
      failedAt: this.deps.clock.now(),
    });
    await reporter.onFailed(downloadError.code);
    return 'skipped';
  }
}
