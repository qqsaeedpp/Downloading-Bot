import type { DownloadType, MediaPlatform } from '@tgtools/shared';
import type { DownloadFailureCode } from '../errors/download-failure-code.js';
import type { DownloadJobStatus } from './job-status.js';

/**
 * The record of one user's one request, from tap to file.
 *
 * Modelled as immutable data with a `version` rather than as a mutable object:
 * two processes touch a job — the bot when the user cancels, the worker as it
 * runs — and the only safe way to reconcile them is for each write to state the
 * version it read and be rejected if that is no longer current.
 */
export interface DownloadJob {
  readonly id: string;
  readonly shortId: string;
  readonly userId: string;

  readonly telegramChatId: number;
  readonly telegramStatusMessageId: number | undefined;

  readonly platform: MediaPlatform;
  readonly sourceUrl: string;
  readonly normalizedUrl: string;
  readonly normalizedUrlHash: string;

  /** Best-effort, from the extractor. Used for the delivered file's caption. */
  readonly mediaTitle: string | undefined;
  readonly mediaType: DownloadType;
  readonly requestedQuality: string | undefined;
  readonly requestedFormatId: string | undefined;

  readonly status: DownloadJobStatus;
  readonly progressPercent: number;
  readonly downloadedBytes: number;
  readonly totalBytes: number | undefined;

  readonly outputSize: number | undefined;
  readonly outputMimeType: string | undefined;
  /** Telegram's own handle for the delivered file. */
  readonly outputFileId: string | undefined;

  readonly errorCode: DownloadFailureCode | undefined;
  readonly errorMessageSafe: string | undefined;

  readonly attemptCount: number;

  readonly createdAt: Date;
  readonly queuedAt: Date | undefined;
  readonly startedAt: Date | undefined;
  readonly completedAt: Date | undefined;
  readonly failedAt: Date | undefined;
  /** After this, the buttons on the card stop working. */
  readonly expiresAt: Date | undefined;
  readonly updatedAt: Date;

  readonly version: number;
}

/** True while the job still has work left to do. */
export function isJobActive(job: Pick<DownloadJob, 'status'>): boolean {
  return (
    job.status !== 'completed' &&
    job.status !== 'failed' &&
    job.status !== 'cancelled' &&
    job.status !== 'expired'
  );
}

/**
 * A tap on a card whose job has already run is not an error the user needs to
 * hear about as a failure; it is simply out of date.
 */
export function isSelectionStillValid(job: DownloadJob, now: Date): boolean {
  if (job.status !== 'awaiting_selection') return false;
  if (job.expiresAt === undefined) return true;
  return job.expiresAt.getTime() > now.getTime();
}
