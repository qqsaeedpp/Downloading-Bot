import type { ToolInputReference } from '@tgtools/tool-contracts';
import type { ToolJobStatus, ToolKey } from '@tgtools/shared';

/**
 * One tool job, as the application sees it.
 *
 * A shape of its own rather than the Drizzle row type. The row carries nulls
 * where the domain means "absent", names columns in database spelling, and
 * would drag `drizzle-orm` into every file that so much as reads a status. The
 * mapper in `infrastructure/persistence` is the only place the two meet.
 *
 * There is deliberately no `operation` here. The queue payload carries the real
 * options — see `toStorableOperation` for why the persisted copy is redacted —
 * so a caller that reads the job row and acts on `operation` would be acting on
 * the sanitised version. Anything that needs the true options gets them from
 * the payload it was handed.
 */
export interface ToolJob {
  readonly id: string;
  readonly shortId: string;
  readonly userId: string;
  readonly telegramChatId: number;
  readonly telegramStatusMessageId: number | undefined;

  readonly toolKey: ToolKey;
  readonly status: ToolJobStatus;
  readonly progressPercent: number;

  readonly output: ToolJobOutput | undefined;

  readonly errorCode: string | undefined;
  readonly errorMessageSafe: string | undefined;

  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly expiresAt: Date | undefined;
  /** The optimistic lock. Every write asserts the value it read. */
  readonly version: number;
}

/** What was produced and sent. Present only once a job has completed. */
export interface ToolJobOutput {
  readonly fileId: string | undefined;
  readonly fileUniqueId: string | undefined;
  readonly mimeType: string | undefined;
  readonly fileName: string | undefined;
  readonly sizeBytes: number | undefined;
}

/** A job together with the files it consumes, in the order the user sent them. */
export interface ToolJobWithInputs {
  readonly job: ToolJob;
  readonly inputs: readonly ToolInputReference[];
}
