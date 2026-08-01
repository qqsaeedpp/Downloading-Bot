import type { DownloadType, MediaPlatform } from '@tgtools/shared';
import type { DownloadJob } from '../entities/download-job.js';
import type { DownloadJobStatus } from '../entities/job-status.js';
import type { DownloadFailureCode } from '../errors/download-failure-code.js';

export interface CreateDownloadJobInput {
  readonly id: string;
  readonly shortId: string;
  readonly userId: string;
  readonly telegramChatId: number;
  readonly telegramStatusMessageId: number | undefined;
  readonly platform: MediaPlatform;
  readonly sourceUrl: string;
  readonly normalizedUrl: string;
  readonly normalizedUrlHash: string;
  readonly mediaType: DownloadType;
  readonly status: DownloadJobStatus;
  readonly expiresAt: Date | undefined;
}

/**
 * A conditional write. `expectedVersion` is what makes two concurrent updates
 * resolvable: the loser sees `false` and can decide what that means, instead of
 * silently clobbering the winner.
 */
export interface UpdateJobStatusInput {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly status: DownloadJobStatus;
  readonly errorCode?: DownloadFailureCode | undefined;
  readonly errorMessageSafe?: string | undefined;
  readonly startedAt?: Date | undefined;
  readonly queuedAt?: Date | undefined;
  readonly completedAt?: Date | undefined;
  readonly failedAt?: Date | undefined;
  readonly incrementAttempt?: boolean | undefined;
}

export interface UpdateJobSelectionInput {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly mediaType: DownloadType;
  readonly requestedQuality: string | undefined;
  readonly requestedFormatId: string | undefined;
  readonly expiresAt: Date | undefined;
}

export interface UpdateJobProgressInput {
  readonly jobId: string;
  readonly progressPercent: number;
  readonly downloadedBytes: number;
  readonly totalBytes: number | undefined;
}

export interface UpdateJobOutputInput {
  readonly jobId: string;
  readonly outputSize: number;
  readonly outputMimeType: string;
  readonly outputFileId: string | undefined;
}

export interface DownloadJobRepository {
  create(input: CreateDownloadJobInput): Promise<DownloadJob>;
  findById(jobId: string): Promise<DownloadJob | undefined>;
  findByShortId(shortId: string): Promise<DownloadJob | undefined>;
  /** Drives the per-user concurrency limit. */
  countActiveByUser(userId: string): Promise<number>;
  /** Returns false when `expectedVersion` no longer matches. */
  updateStatus(input: UpdateJobStatusInput): Promise<boolean>;
  updateSelection(input: UpdateJobSelectionInput): Promise<boolean>;
  /**
   * Progress is deliberately version-free: it is advisory, it is written often,
   * and a lost update costs a stale percentage for three seconds. Making it
   * conditional would put a write conflict on the hot path for no benefit.
   */
  updateProgress(input: UpdateJobProgressInput): Promise<void>;
  updateOutput(input: UpdateJobOutputInput): Promise<void>;
  attachStatusMessage(jobId: string, messageId: number): Promise<void>;
  /** Version-free: descriptive only, and never a reason to lose a race. */
  attachMediaTitle(jobId: string, title: string): Promise<void>;
  /** Marks stale `awaiting_selection` rows expired. Returns how many. */
  expireStaleSelections(now: Date, limit: number): Promise<number>;
}
