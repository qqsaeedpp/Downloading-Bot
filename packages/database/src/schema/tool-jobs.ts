import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * File-tool jobs, deliberately NOT sharing `download_jobs`.
 *
 * The two look similar for about five columns and then diverge completely: a
 * download has a platform, a source URL and a requested quality; a tool job has
 * an operation, a set of uploaded inputs and a per-tool option payload. Forcing
 * both into one table would mean a dozen columns that are null for half the
 * rows, and a status enum that has to mean two different things.
 *
 * `tool_key` and `status` are TEXT, not PostgreSQL enums. Adding a ninth tool
 * would otherwise need a migration that rewrites a type — and this project has
 * already shipped a release where an enum value existed in the code and not in
 * the database, which failed every insert for that value. The application
 * vocabulary plus a Zod check at the boundary gives the same guarantee without
 * the DDL.
 */
export const toolJobs = pgTable(
  'tool_jobs',
  {
    id: uuid('id').primaryKey(),
    /**
     * Short, opaque handle for Telegram callback data, which is capped at 64
     * BYTES — a UUID plus a namespace, a version and an action does not fit.
     */
    shortId: text('short_id').notNull(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }).notNull(),
    telegramStatusMessageId: integer('telegram_status_message_id'),

    /** One of `ALL_TOOL_KEYS`; see the note above on why this is not an enum. */
    toolKey: text('tool_key').notNull(),
    /**
     * Which shape `operation_payload` is in. Read BEFORE the payload is parsed,
     * so a row written by an older release is recognised as such rather than
     * failing a schema check with a confusing message.
     */
    operationSchemaVersion: integer('operation_schema_version').notNull().default(1),
    /**
     * The tool's own validated options — quality, dimensions, page range.
     *
     * Never the input itself: no file bytes, no Telegram file path, no URL, and
     * for QR no payload text. A user's QR content can be a password or a Wi-Fi
     * key, and an audit table is exactly the wrong place for it.
     */
    operationPayload: jsonb('operation_payload').notNull(),

    status: text('status').notNull().default('pending'),
    progressPercent: integer('progress_percent').notNull().default(0),

    outputFileId: text('output_file_id'),
    outputFileUniqueId: text('output_file_unique_id'),
    outputMimeType: text('output_mime_type'),
    outputFileName: text('output_file_name'),
    outputSize: bigint('output_size', { mode: 'number' }),

    errorCode: text('error_code'),
    /** Already sanitised. Raw ffmpeg/poppler output never leaves the log. */
    errorMessageSafe: text('error_message_safe'),

    attemptCount: integer('attempt_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /**
     * Optimistic lock, same contract as `download_jobs`: every transition
     * asserts the version it read, so a duplicate queue delivery and a user's
     * cancel tap cannot both win.
     */
    version: integer('version').notNull().default(0),
  },
  (table) => [
    uniqueIndex('tool_jobs_short_id_key').on(table.shortId),
    index('tool_jobs_user_id_idx').on(table.userId),
    index('tool_jobs_status_idx').on(table.status),
    index('tool_jobs_created_at_idx').on(table.createdAt),
    // Serves the per-user active-job ceiling, checked on every new request.
    index('tool_jobs_user_status_idx').on(table.userId, table.status),
    index('tool_jobs_expires_at_idx').on(table.expiresAt),
  ],
);

export type ToolJobRow = typeof toolJobs.$inferSelect;
export type NewToolJobRow = typeof toolJobs.$inferInsert;

/**
 * The files a job consumes, in the order the user sent them.
 *
 * A child table rather than a JSON array on the job because order and identity
 * both matter — "images to PDF" is defined by its sequence — and because a
 * cancelled album needs the last entry removed, which is a DELETE here and a
 * read-modify-write there.
 *
 * Only Telegram REFERENCES are stored. The worker resolves each file when it
 * runs, so no path and no token-bearing URL is ever persisted.
 */
export const toolJobInputs = pgTable(
  'tool_job_inputs',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => toolJobs.id, { onDelete: 'cascade' }),
    /** Zero-based position; the PDF page order is literally this column. */
    inputOrder: integer('input_order').notNull(),

    telegramFileId: text('telegram_file_id').notNull(),
    telegramFileUniqueId: text('telegram_file_unique_id').notNull(),

    /**
     * What Telegram CLAIMED. Kept for diagnostics and never trusted: the real
     * type is decided from magic bytes after the file is fetched.
     */
    declaredFileName: text('declared_file_name'),
    declaredMimeType: text('declared_mime_type'),
    declaredSize: bigint('declared_size', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('tool_job_inputs_job_id_idx').on(table.jobId),
    // The order is part of the contract, so make a duplicate position
    // impossible rather than merely unlikely.
    uniqueIndex('tool_job_inputs_job_order_key').on(table.jobId, table.inputOrder),
  ],
);

export type ToolJobInputRow = typeof toolJobInputs.$inferSelect;
export type NewToolJobInputRow = typeof toolJobInputs.$inferInsert;

/**
 * An append-only trail of what happened to a job.
 *
 * Exists because the interesting failures here are not reproducible: a
 * container was killed mid-render, an album arrived out of order, a cancel
 * raced a completion. Without a trail those are unanswerable after the fact,
 * and the job row only ever shows the final state.
 *
 * `safe_payload` is named for the rule it enforces: whatever goes in has
 * already been sanitised. No raw stderr, no filenames from the user, no
 * credentials.
 */
export const toolJobEvents = pgTable(
  'tool_job_events',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => toolJobs.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    safePayload: jsonb('safe_payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('tool_job_events_job_id_idx').on(table.jobId),
    index('tool_job_events_created_at_idx').on(table.createdAt),
  ],
);

export type ToolJobEventRow = typeof toolJobEvents.$inferSelect;
export type NewToolJobEventRow = typeof toolJobEvents.$inferInsert;
