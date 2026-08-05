import type { ToolJobStatus, ToolKey } from '@tgtools/shared';
import type { ToolInputReference } from '@tgtools/tool-contracts';
import type { ToolJob, ToolJobWithInputs } from '../tool-job.js';

/**
 * Everything the two processes need from `tool_jobs`.
 *
 * An interface rather than the Drizzle class directly because both the bot and
 * the tools worker depend on it, and because the use cases above it are worth
 * testing without a Postgres. The one implementation lives beside it in
 * `infrastructure/persistence`.
 */

export interface CreateToolJobInput {
  readonly id: string;
  readonly shortId: string;
  readonly userId: string;
  readonly telegramChatId: number;
  readonly telegramStatusMessageId: number | undefined;
  readonly toolKey: ToolKey;
  /**
   * ALREADY REDACTED by `toStorableOperation`. The parameter is named for the
   * rule so a call site passing the raw operation reads as obviously wrong: for
   * QR that operation contains whatever the user typed, up to and including a
   * Wi-Fi password, and this row has no expiry.
   */
  readonly storableOperation: Readonly<Record<string, unknown>>;
  readonly operationSchemaVersion: number;
  readonly inputs: readonly ToolInputReference[];
  readonly expiresAt: Date | undefined;
}

export interface UpdateToolJobStatusInput {
  readonly jobId: string;
  readonly status: ToolJobStatus;
  readonly expectedVersion: number;
  readonly errorCode?: string | undefined;
  readonly errorMessageSafe?: string | undefined;
  readonly incrementAttempt?: boolean | undefined;
}

export interface CompleteToolJobInput {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly outputFileId: string | undefined;
  readonly outputFileUniqueId: string | undefined;
  readonly outputMimeType: string | undefined;
  readonly outputFileName: string | undefined;
  readonly outputSize: number | undefined;
}

export interface ToolJobRepository {
  /** Job and inputs in ONE transaction: a job with no files is unrunnable. */
  create(input: CreateToolJobInput): Promise<ToolJob>;
  findById(jobId: string): Promise<ToolJob | undefined>;
  findByShortId(shortId: string): Promise<ToolJob | undefined>;
  /** The worker's read: it needs the file references, not just the job. */
  findWithInputs(jobId: string): Promise<ToolJobWithInputs | undefined>;
  countActiveByUser(userId: string): Promise<number>;
  /** False when the version did not match — another writer won the race. */
  updateStatus(input: UpdateToolJobStatusInput): Promise<boolean>;
  /** Unversioned and unguarded: progress is advisory and written often. */
  updateProgress(jobId: string, progressPercent: number): Promise<void>;
  complete(input: CompleteToolJobInput): Promise<boolean>;
  /** Sweeps jobs left live by a crash. Returns how many were expired. */
  expireStale(now: Date, limit: number): Promise<number>;
}

/**
 * The append-only trail beside the job row.
 *
 * Separate from the job repository because the failures worth investigating
 * here are not reproducible — a container killed mid-render, an album that
 * arrived out of order, a cancel that raced a completion — and the job row only
 * ever shows the final state.
 */
export interface ToolJobEventRepository {
  /** `payload` must already be safe: no raw stderr, no user filenames, no secrets. */
  record(
    jobId: string,
    eventType: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}
