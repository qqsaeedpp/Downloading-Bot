import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { downloadJobs } from './download-jobs.js';

/**
 * An append-only trail of what happened to a job. Kept separate from
 * `download_jobs` so that the row a user's next tap reads stays small and
 * contended by nothing, while the history can grow and be pruned on its own
 * schedule.
 */
export const downloadEvents = pgTable(
  'download_events',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => downloadJobs.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    /** Bounded and sanitised before it gets here — never raw tool output. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('download_events_job_id_idx').on(table.jobId),
    index('download_events_created_at_idx').on(table.createdAt),
  ],
);

export type DownloadEventRow = typeof downloadEvents.$inferSelect;
export type NewDownloadEventRow = typeof downloadEvents.$inferInsert;
