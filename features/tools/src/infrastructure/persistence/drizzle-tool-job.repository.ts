import type { Db } from '@tgtools/database';
import { toolJobEvents, toolJobInputs, toolJobs } from '@tgtools/database';
import type { Clock, IdGenerator } from '@tgtools/shared';
import { InvariantViolationError, ToolJobStatus } from '@tgtools/shared';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  CompleteToolJobInput,
  CreateToolJobInput,
  ToolJobEventRepository,
  ToolJobRepository,
  UpdateToolJobStatusInput,
} from '../../domain/ports/tool-job.repository.js';
import type { ToolJob, ToolJobWithInputs } from '../../domain/tool-job.js';
import { ACTIVE_TOOL_STATUSES, assertToolTransition } from '../../domain/tool-job-status.js';
import { toToolInputReference, toToolJob } from './tool-row-mappers.js';

export class DrizzleToolJobRepository implements ToolJobRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Job and inputs together, in one transaction.
   *
   * Not two statements: a job row whose inputs failed to insert is a job the
   * worker will dequeue, find nothing to work on, and fail — after the user has
   * been told it was accepted. The row and the files it consumes are one fact.
   */
  async create(input: CreateToolJobInput): Promise<ToolJob> {
    const now = this.clock.now();

    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(toolJobs)
        .values({
          id: input.id,
          shortId: input.shortId,
          userId: input.userId,
          telegramChatId: input.telegramChatId,
          telegramStatusMessageId: input.telegramStatusMessageId ?? null,
          toolKey: input.toolKey,
          operationSchemaVersion: input.operationSchemaVersion,
          // Already redacted by `toStorableOperation`; see the port's comment on
          // why the parameter is named for that rule.
          operationPayload: input.storableOperation,
          status: ToolJobStatus.Pending,
          expiresAt: input.expiresAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (inserted === undefined) {
        throw new InvariantViolationError('Insert of a tool job returned no row');
      }

      if (input.inputs.length > 0) {
        await tx.insert(toolJobInputs).values(
          input.inputs.map((reference, index) => ({
            id: this.ids.uuid(),
            jobId: input.id,
            // The array position, not the arrival timestamp. This column IS the
            // page order for images-to-PDF.
            inputOrder: index,
            telegramFileId: reference.fileId,
            telegramFileUniqueId: reference.fileUniqueId,
            declaredFileName: reference.originalName ?? null,
            declaredMimeType: reference.declaredMimeType ?? null,
            declaredSize: reference.declaredSize ?? null,
            createdAt: now,
          })),
        );
      }

      return inserted;
    });

    return toToolJob(row);
  }

  async findById(jobId: string): Promise<ToolJob | undefined> {
    const [row] = await this.db.select().from(toolJobs).where(eq(toolJobs.id, jobId)).limit(1);
    return row === undefined ? undefined : toToolJob(row);
  }

  async findByShortId(shortId: string): Promise<ToolJob | undefined> {
    const [row] = await this.db
      .select()
      .from(toolJobs)
      .where(eq(toolJobs.shortId, shortId))
      .limit(1);
    return row === undefined ? undefined : toToolJob(row);
  }

  async findWithInputs(jobId: string): Promise<ToolJobWithInputs | undefined> {
    const job = await this.findById(jobId);
    if (job === undefined) return undefined;

    const rows = await this.db
      .select()
      .from(toolJobInputs)
      .where(eq(toolJobInputs.jobId, jobId))
      // Ordered in SQL rather than in memory. Without it Postgres may return
      // the rows in any order it likes, and the user's PDF comes back shuffled.
      .orderBy(asc(toolJobInputs.inputOrder));

    return { job, inputs: rows.map(toToolInputReference) };
  }

  async countActiveByUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(toolJobs)
      .where(and(eq(toolJobs.userId, userId), inArray(toolJobs.status, [...ACTIVE_TOOL_STATUSES])));
    return row?.total ?? 0;
  }

  /**
   * The guard runs twice, for two different failures.
   *
   * In memory, {@link assertToolTransition} rejects a nonsensical move — a bug,
   * which should throw rather than write. In the database, the `version`
   * predicate rejects a STALE move: two writers that both read version 3 cannot
   * both write version 4, so the loser gets `false` and decides what that means.
   */
  async updateStatus(input: UpdateToolJobStatusInput): Promise<boolean> {
    const current = await this.findById(input.jobId);
    if (current === undefined) return false;
    if (current.version !== input.expectedVersion) return false;
    assertToolTransition(current.status, input.status);

    const now = this.clock.now();
    const updated = await this.db
      .update(toolJobs)
      .set({
        status: input.status,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.errorMessageSafe === undefined
          ? {}
          : { errorMessageSafe: input.errorMessageSafe }),
        ...timestampFor(input.status, now),
        ...(input.incrementAttempt === true
          ? { attemptCount: sql`${toolJobs.attemptCount} + 1` }
          : {}),
        updatedAt: now,
        version: sql`${toolJobs.version} + 1`,
      })
      .where(and(eq(toolJobs.id, input.jobId), eq(toolJobs.version, input.expectedVersion)))
      .returning({ id: toolJobs.id });

    return updated.length > 0;
  }

  async updateProgress(jobId: string, progressPercent: number): Promise<void> {
    // No version predicate and no version bump: progress is advisory and
    // written several times a second, so making it conditional would put a
    // write conflict on the hot path in order to save a stale percentage.
    await this.db
      .update(toolJobs)
      .set({ progressPercent: clampPercent(progressPercent), updatedAt: this.clock.now() })
      .where(eq(toolJobs.id, jobId));
  }

  /**
   * The output and the terminal status in ONE write.
   *
   * Splitting them leaves a window where the job reads as completed with no
   * file attached, and the status message the user is looking at is rendered
   * from exactly that row.
   */
  async complete(input: CompleteToolJobInput): Promise<boolean> {
    const current = await this.findById(input.jobId);
    if (current === undefined) return false;
    if (current.version !== input.expectedVersion) return false;
    assertToolTransition(current.status, ToolJobStatus.Completed);

    const now = this.clock.now();
    const updated = await this.db
      .update(toolJobs)
      .set({
        status: ToolJobStatus.Completed,
        progressPercent: 100,
        outputFileId: input.outputFileId ?? null,
        outputFileUniqueId: input.outputFileUniqueId ?? null,
        outputMimeType: input.outputMimeType ?? null,
        outputFileName: input.outputFileName ?? null,
        outputSize: input.outputSize ?? null,
        completedAt: now,
        updatedAt: now,
        version: sql`${toolJobs.version} + 1`,
      })
      .where(and(eq(toolJobs.id, input.jobId), eq(toolJobs.version, input.expectedVersion)))
      .returning({ id: toolJobs.id });

    return updated.length > 0;
  }

  /**
   * Expire jobs a crash left live.
   *
   * Bounded by `limit` so one sweep cannot lock a large slice of the table, and
   * the status is re-checked inside the UPDATE because a worker may have
   * finished one of these rows between the select and the write.
   */
  async expireStale(now: Date, limit: number): Promise<number> {
    const stale = await this.db
      .select({ id: toolJobs.id })
      .from(toolJobs)
      .where(and(inArray(toolJobs.status, [...ACTIVE_TOOL_STATUSES]), lt(toolJobs.expiresAt, now)))
      .limit(limit);

    if (stale.length === 0) return 0;

    const updated = await this.db
      .update(toolJobs)
      .set({
        status: ToolJobStatus.Expired,
        updatedAt: now,
        version: sql`${toolJobs.version} + 1`,
      })
      .where(
        and(
          inArray(
            toolJobs.id,
            stale.map((row) => row.id),
          ),
          inArray(toolJobs.status, [...ACTIVE_TOOL_STATUSES]),
        ),
      )
      .returning({ id: toolJobs.id });

    return updated.length;
  }
}

/**
 * Stamp the column that matches the status.
 *
 * The row carries a timestamp per outcome rather than one `endedAt`, because
 * "when did this fail" and "when was it cancelled" are different questions and
 * a single column cannot answer both.
 */
function timestampFor(status: ToolJobStatus, now: Date): Record<string, Date> {
  switch (status) {
    case ToolJobStatus.Queued:
      return { queuedAt: now };
    case ToolJobStatus.Receiving:
    case ToolJobStatus.Processing:
      // `startedAt` marks when WORK began, and for a job that takes a file that
      // is the moment the fetch starts, not the moment ffmpeg does.
      return { startedAt: now };
    case ToolJobStatus.Failed:
      return { failedAt: now };
    case ToolJobStatus.Cancelled:
      return { cancelledAt: now };
    case ToolJobStatus.Completed:
      return { completedAt: now };
    default:
      return {};
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The append-only trail beside the job row.
 *
 * Failures worth investigating here are not reproducible — a container killed
 * mid-render, an album that arrived out of order, a cancel that raced a
 * completion — and the job row only ever shows the final state.
 */
export class DrizzleToolJobEventRepository implements ToolJobEventRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async record(
    jobId: string,
    eventType: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.db.insert(toolJobEvents).values({
      id: this.ids.uuid(),
      jobId,
      eventType,
      safePayload: payload ?? null,
      createdAt: this.clock.now(),
    });
  }
}
