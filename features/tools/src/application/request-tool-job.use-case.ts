import type { Clock, IdGenerator, Logger, ToolKey } from '@tgtools/shared';
import { ToolJobStatus, describeError } from '@tgtools/shared';
import { TOOL_JOB_SCHEMA_VERSION, toStorableOperation } from '@tgtools/tool-contracts';
import type { ToolInputReference, ToolOperation } from '@tgtools/tool-contracts';
import type { ToolQueuePort } from '../domain/ports/supporting-ports.js';
import type { ToolJobRepository } from '../domain/ports/tool-job.repository.js';

/**
 * Turning a finished conversation into a queued job.
 *
 * The ordering is the whole of it. The row is written BEFORE the queue message,
 * because a message referring to a row that does not exist is a job the worker
 * dequeues, cannot find and discards — with the user already told it was
 * accepted. The reverse leak is survivable: a row with no message is a job that
 * sits in `pending` and is swept by the maintenance loop.
 *
 * Rather than a use case per tool, one that takes an already-validated
 * `ToolOperation`. Every tool's differences were spent in the option flow that
 * built it; from here they are identical.
 */

export interface RequestToolJobInput {
  readonly userId: string;
  readonly telegramUserId: number;
  readonly telegramChatId: number;
  readonly statusMessageId: number;
  readonly requestId: string;
  readonly tool: ToolKey;
  readonly operation: ToolOperation;
  readonly inputs: readonly ToolInputReference[];
}

export type RequestToolJobResult =
  | { readonly ok: true; readonly jobId: string; readonly shortId: string }
  | { readonly ok: false; readonly reason: 'too-many-active' };

export interface RequestToolJobDeps {
  readonly repository: ToolJobRepository;
  readonly queue: ToolQueuePort;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxActiveJobsPerUser: number;
  /** How long a job may sit unfinished before the sweep expires it. */
  readonly jobTimeoutMs: number;
}

export class RequestToolJobUseCase {
  constructor(private readonly deps: RequestToolJobDeps) {}

  async execute(input: RequestToolJobInput): Promise<RequestToolJobResult> {
    // Checked before anything is written. This is the only thing standing
    // between one user and the whole worker: video runs at a concurrency of 1,
    // so a handful of unbounded requests would stall the queue for everyone.
    const active = await this.deps.repository.countActiveByUser(input.userId);
    if (active >= this.deps.maxActiveJobsPerUser) {
      return { ok: false, reason: 'too-many-active' };
    }

    const jobId = this.deps.ids.uuid();
    const shortId = this.deps.ids.short(8);
    const now = this.deps.clock.now();

    const job = await this.deps.repository.create({
      id: jobId,
      shortId,
      userId: input.userId,
      telegramChatId: input.telegramChatId,
      telegramStatusMessageId: input.statusMessageId,
      toolKey: input.tool,
      // Redacted here, at the only place a row is written. For QR this drops
      // everything the user typed — it can be a Wi-Fi password, and this table
      // has no expiry.
      storableOperation: toStorableOperation(input.operation),
      operationSchemaVersion: TOOL_JOB_SCHEMA_VERSION,
      inputs: input.inputs,
      expiresAt: new Date(now.getTime() + this.deps.jobTimeoutMs),
    });

    const moved = await this.deps.repository.updateStatus({
      jobId,
      status: ToolJobStatus.Queued,
      expectedVersion: job.version,
    });
    if (!moved) {
      // Nothing else can have touched a row created microseconds ago, so this
      // means the write itself failed. Enqueuing anyway would produce a job the
      // worker refuses on sight, because it checks for a terminal status.
      this.deps.logger.error('could not mark a new tool job as queued', { jobId });
      return { ok: false, reason: 'too-many-active' };
    }

    try {
      await this.deps.queue.enqueue({
        schemaVersion: TOOL_JOB_SCHEMA_VERSION,
        jobId,
        shortId,
        requestId: input.requestId,
        telegram: {
          userId: input.telegramUserId,
          chatId: input.telegramChatId,
          statusMessageId: input.statusMessageId,
        },
        tool: input.tool,
        // The FULL operation, not the redacted one. The queue is where the QR
        // content legitimately lives: for as long as the job takes, and nowhere
        // else.
        operation: input.operation,
        inputs: [...input.inputs],
      });
    } catch (error: unknown) {
      // The row is already `queued`, so the maintenance sweep will expire it
      // rather than leaving it live forever. Reported as a failure to the
      // caller so the user is told, instead of watching a status that will
      // never change.
      this.deps.logger.error('could not enqueue a tool job', {
        jobId,
        error: describeError(error),
      });
      throw error;
    }

    return { ok: true, jobId, shortId };
  }
}
