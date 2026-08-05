import type { ToolJobInputRow, ToolJobRow } from '@tgtools/database';
import type { ToolJobStatus, ToolKey } from '@tgtools/shared';
import { InvariantViolationError, TOOL_JOB_STATUS_VALUES, isToolKey } from '@tgtools/shared';
import type { ToolInputReference } from '@tgtools/tool-contracts';
import type { ToolJob, ToolJobOutput } from '../../domain/tool-job.js';

/**
 * The one place a database row becomes a domain object.
 *
 * `tool_key` and `status` are TEXT columns, not PostgreSQL enums — a deliberate
 * choice so that adding a ninth tool needs no DDL. The price of that choice is
 * paid here: nothing in the database stops a row carrying a value this build has
 * never heard of, which is exactly what a rollback produces when the previous
 * release wrote jobs for a tool the current one does not have.
 *
 * So both are checked. Failing at the mapper names the offending value; passing
 * it through fails later inside a `switch` that falls off the end, with a
 * message about `undefined` and no mention of the row that caused it.
 */

function assertToolKey(value: string, jobId: string): ToolKey {
  if (!isToolKey(value)) {
    throw new InvariantViolationError(
      `Tool job "${jobId}" names the tool "${value}", which this build has no handler for. ` +
        'The usual cause is a rollback: a newer release wrote the row.',
      { context: { jobId, toolKey: value } },
    );
  }
  return value;
}

function assertStatus(value: string, jobId: string): ToolJobStatus {
  if (!(TOOL_JOB_STATUS_VALUES as readonly string[]).includes(value)) {
    throw new InvariantViolationError(
      `Tool job "${jobId}" is in the status "${value}", which is not in this build's vocabulary.`,
      { context: { jobId, status: value } },
    );
  }
  return value as ToolJobStatus;
}

/**
 * Present only when something was actually produced.
 *
 * Returning an object of undefineds instead would make `if (job.output)` true
 * for a job that produced nothing, which is the check every caller writes to
 * decide whether there is a file to talk about.
 */
function toOutput(row: ToolJobRow): ToolJobOutput | undefined {
  const hasOutput =
    row.outputFileId !== null ||
    row.outputFileUniqueId !== null ||
    row.outputFileName !== null ||
    row.outputSize !== null;
  if (!hasOutput) return undefined;

  return {
    fileId: row.outputFileId ?? undefined,
    fileUniqueId: row.outputFileUniqueId ?? undefined,
    mimeType: row.outputMimeType ?? undefined,
    fileName: row.outputFileName ?? undefined,
    sizeBytes: row.outputSize ?? undefined,
  };
}

export function toToolJob(row: ToolJobRow): ToolJob {
  return {
    id: row.id,
    shortId: row.shortId,
    userId: row.userId,
    telegramChatId: row.telegramChatId,
    telegramStatusMessageId: row.telegramStatusMessageId ?? undefined,
    toolKey: assertToolKey(row.toolKey, row.id),
    status: assertStatus(row.status, row.id),
    progressPercent: row.progressPercent,
    output: toOutput(row),
    errorCode: row.errorCode ?? undefined,
    errorMessageSafe: row.errorMessageSafe ?? undefined,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? undefined,
    version: row.version,
  };
}

/**
 * Rebuild a session-shaped reference from a stored input.
 *
 * `receivedAtMs` is synthesised from `input_order`, not read from a clock. The
 * field exists so that an album — which arrives as several independent updates —
 * can be sorted back into the order the user sent it, and once the rows exist
 * the ORDER COLUMN is the authoritative answer to that question. Two photos in
 * one album are written within the same millisecond, so a real timestamp could
 * not distinguish them at all.
 */
export function toToolInputReference(row: ToolJobInputRow): ToolInputReference {
  return {
    fileId: row.telegramFileId,
    fileUniqueId: row.telegramFileUniqueId,
    ...(row.declaredSize === null ? {} : { declaredSize: row.declaredSize }),
    ...(row.declaredMimeType === null ? {} : { declaredMimeType: row.declaredMimeType }),
    // Metadata only: it is shown back to the user and used to pick an
    // extension. The workspace generates every path it opens, so this
    // attacker-controlled string never reaches a filesystem call.
    ...(row.declaredFileName === null ? {} : { originalName: row.declaredFileName }),
    receivedAtMs: row.createdAt.getTime() + row.inputOrder,
  };
}
