import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jobStatusEnum, mediaTypeEnum, platformEnum } from './enums.js';
import { users } from './users.js';

export const downloadJobs = pgTable(
  'download_jobs',
  {
    id: uuid('id').primaryKey(),
    /**
     * Short, opaque handle used in Telegram callback data, which is capped at
     * 64 bytes — a full UUID plus an action and an option id does not fit.
     */
    shortId: text('short_id').notNull(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }).notNull(),
    telegramStatusMessageId: integer('telegram_status_message_id'),

    platform: platformEnum('platform').notNull(),
    /**
     * What we persist depends on `STORE_FULL_SOURCE_URL`: by default the query
     * string — which can carry a signed CDN token — is stripped first.
     */
    sourceUrl: text('source_url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    /** SHA-256 of the normalised URL: indexable, and reveals nothing on its own. */
    normalizedUrlHash: text('normalized_url_hash').notNull(),

    /**
     * Recorded at inspection time so the delivered file can carry a meaningful
     * caption without the worker having to re-inspect — the Redis cache is
     * short-lived, and a queued job can outlive it.
     */
    mediaTitle: text('media_title'),

    mediaType: mediaTypeEnum('media_type').notNull(),
    requestedQuality: text('requested_quality'),
    requestedFormatId: text('requested_format_id'),

    status: jobStatusEnum('status').notNull().default('pending'),
    progressPercent: integer('progress_percent').notNull().default(0),
    downloadedBytes: bigint('downloaded_bytes', { mode: 'number' }).notNull().default(0),
    totalBytes: bigint('total_bytes', { mode: 'number' }),

    outputSize: bigint('output_size', { mode: 'number' }),
    outputMimeType: text('output_mime_type'),
    /** Telegram's own handle for the uploaded file; lets a repeat be served free. */
    outputFileId: text('output_file_id'),

    errorCode: text('error_code'),
    /** Already sanitised. The raw tool output never leaves the log. */
    errorMessageSafe: text('error_message_safe'),

    attemptCount: integer('attempt_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /**
     * Optimistic lock. Every state transition asserts the version it read, so a
     * duplicate queue delivery and a user's cancel tap cannot both "win".
     */
    version: integer('version').notNull().default(0),
  },
  (table) => [
    uniqueIndex('download_jobs_short_id_key').on(table.shortId),
    index('download_jobs_user_id_idx').on(table.userId),
    index('download_jobs_status_idx').on(table.status),
    index('download_jobs_created_at_idx').on(table.createdAt),
    index('download_jobs_normalized_url_hash_idx').on(table.normalizedUrlHash),
    // Serves the "how many jobs is this user already running" check on the hot
    // path of every new request.
    index('download_jobs_user_status_idx').on(table.userId, table.status),
    index('download_jobs_expires_at_idx').on(table.expiresAt),
  ],
);

export type DownloadJobRow = typeof downloadJobs.$inferSelect;
export type NewDownloadJobRow = typeof downloadJobs.$inferInsert;
