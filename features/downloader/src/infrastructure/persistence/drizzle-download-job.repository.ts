import type { Db } from '@tgtools/database';
import { downloadJobs } from '@tgtools/database';
import type { Clock } from '@tgtools/shared';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DownloadJob } from '../../domain/entities/download-job.js';
import {
  ACTIVE_STATUSES,
  DownloadJobStatus,
  assertTransition,
} from '../../domain/entities/job-status.js';
import type {
  CreateDownloadJobInput,
  DownloadJobRepository,
  UpdateJobOutputInput,
  UpdateJobProgressInput,
  UpdateJobSelectionInput,
  UpdateJobStatusInput,
} from '../../domain/ports/download-job.repository.js';
import { DownloadError } from '../../domain/errors/download-error.js';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import { toDownloadJob } from './row-mappers.js';

export class DrizzleDownloadJobRepository implements DownloadJobRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async create(input: CreateDownloadJobInput): Promise<DownloadJob> {
    const now = this.clock.now();
    const [row] = await this.db
      .insert(downloadJobs)
      .values({
        id: input.id,
        shortId: input.shortId,
        userId: input.userId,
        telegramChatId: input.telegramChatId,
        telegramStatusMessageId: input.telegramStatusMessageId ?? null,
        platform: input.platform,
        sourceUrl: input.sourceUrl,
        normalizedUrl: input.normalizedUrl,
        normalizedUrlHash: input.normalizedUrlHash,
        mediaType: input.mediaType,
        status: input.status,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (row === undefined) {
      throw DownloadError.internal('Insert of download job returned no row');
    }
    return toDownloadJob(row);
  }

  async findById(jobId: string): Promise<DownloadJob | undefined> {
    const [row] = await this.db
      .select()
      .from(downloadJobs)
      .where(eq(downloadJobs.id, jobId))
      .limit(1);
    return row === undefined ? undefined : toDownloadJob(row);
  }

  async findByShortId(shortId: string): Promise<DownloadJob | undefined> {
    const [row] = await this.db
      .select()
      .from(downloadJobs)
      .where(eq(downloadJobs.shortId, shortId))
      .limit(1);
    return row === undefined ? undefined : toDownloadJob(row);
  }

  async countActiveByUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(downloadJobs)
      .where(
        and(eq(downloadJobs.userId, userId), inArray(downloadJobs.status, [...ACTIVE_STATUSES])),
      );
    return row?.total ?? 0;
  }

  /**
   * The transition guard runs twice on purpose.
   *
   * In memory, {@link assertTransition} rejects a nonsensical move — a bug, and
   * it should throw rather than write. In the database, the `version` predicate
   * rejects a *stale* move: two actors that both read version 3 cannot both
   * write version 4, so the second one gets `false` and decides what that
   * means. Neither check subsumes the other.
   */
  async updateStatus(input: UpdateJobStatusInput): Promise<boolean> {
    const current = await this.findById(input.jobId);
    if (current === undefined) return false;
    if (current.version !== input.expectedVersion) return false;
    assertTransition(current.status, input.status);

    const now = this.clock.now();
    const updated = await this.db
      .update(downloadJobs)
      .set({
        status: input.status,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.errorMessageSafe === undefined
          ? {}
          : { errorMessageSafe: input.errorMessageSafe }),
        ...(input.queuedAt === undefined ? {} : { queuedAt: input.queuedAt }),
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
        ...(input.failedAt === undefined ? {} : { failedAt: input.failedAt }),
        ...(input.incrementAttempt === true
          ? { attemptCount: sql`${downloadJobs.attemptCount} + 1` }
          : {}),
        updatedAt: now,
        version: sql`${downloadJobs.version} + 1`,
      })
      .where(and(eq(downloadJobs.id, input.jobId), eq(downloadJobs.version, input.expectedVersion)))
      .returning({ id: downloadJobs.id });

    return updated.length > 0;
  }

  async updateSelection(input: UpdateJobSelectionInput): Promise<boolean> {
    const updated = await this.db
      .update(downloadJobs)
      .set({
        mediaType: input.mediaType,
        requestedQuality: input.requestedQuality ?? null,
        requestedFormatId: input.requestedFormatId ?? null,
        expiresAt: input.expiresAt ?? null,
        updatedAt: this.clock.now(),
        version: sql`${downloadJobs.version} + 1`,
      })
      .where(
        and(
          eq(downloadJobs.id, input.jobId),
          eq(downloadJobs.version, input.expectedVersion),
          // Belt and braces: even with the right version, a job that has moved
          // past selection must not have its choice rewritten.
          eq(downloadJobs.status, DownloadJobStatus.AwaitingSelection),
        ),
      )
      .returning({ id: downloadJobs.id });

    return updated.length > 0;
  }

  async updateProgress(input: UpdateJobProgressInput): Promise<void> {
    // No version predicate and no version bump: progress is advisory and
    // written several times a second, so making it conditional would put a
    // write conflict on the hot path to save a stale percentage.
    await this.db
      .update(downloadJobs)
      .set({
        progressPercent: clampPercent(input.progressPercent),
        downloadedBytes: input.downloadedBytes,
        totalBytes: input.totalBytes ?? null,
        updatedAt: this.clock.now(),
      })
      .where(eq(downloadJobs.id, input.jobId));
  }

  async updateOutput(input: UpdateJobOutputInput): Promise<void> {
    await this.db
      .update(downloadJobs)
      .set({
        outputSize: input.outputSize,
        outputMimeType: input.outputMimeType,
        outputFileId: input.outputFileId ?? null,
        updatedAt: this.clock.now(),
      })
      .where(eq(downloadJobs.id, input.jobId));
  }

  async attachStatusMessage(jobId: string, messageId: number): Promise<void> {
    await this.db
      .update(downloadJobs)
      .set({ telegramStatusMessageId: messageId, updatedAt: this.clock.now() })
      .where(eq(downloadJobs.id, jobId));
  }

  async attachMediaTitle(jobId: string, title: string): Promise<void> {
    await this.db
      .update(downloadJobs)
      // Bounded here rather than trusted: the title is a remote string and the
      // column has no length limit of its own.
      .set({ mediaTitle: title.slice(0, 300), updatedAt: this.clock.now() })
      .where(eq(downloadJobs.id, jobId));
  }

  async expireStaleSelections(now: Date, limit: number): Promise<number> {
    const stale = await this.db
      .select({ id: downloadJobs.id })
      .from(downloadJobs)
      .where(
        and(
          eq(downloadJobs.status, DownloadJobStatus.AwaitingSelection),
          lt(downloadJobs.expiresAt, now),
        ),
      )
      .limit(limit);

    if (stale.length === 0) return 0;

    const updated = await this.db
      .update(downloadJobs)
      .set({
        status: DownloadJobStatus.Expired,
        errorCode: DownloadFailureCode.SelectionExpired,
        updatedAt: now,
        version: sql`${downloadJobs.version} + 1`,
      })
      .where(
        and(
          inArray(
            downloadJobs.id,
            stale.map((row) => row.id),
          ),
          // Re-checked inside the write: a user may have tapped a button in the
          // moment between the select and the update.
          eq(downloadJobs.status, DownloadJobStatus.AwaitingSelection),
        ),
      )
      .returning({ id: downloadJobs.id });

    return updated.length;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
