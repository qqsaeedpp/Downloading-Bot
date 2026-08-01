import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { platformEnum } from './enums.js';

/**
 * A durable second tier behind the Redis cache, so a Redis flush does not send
 * every open quality menu back to the extractor.
 *
 * Keyed by the *hash* of the normalised URL, never the URL: this table is the
 * one an operator is most likely to eyeball, and the hash is enough to join on.
 * `requiredAuth` is part of the key decision — a result obtained with operator
 * cookies may show more than an anonymous visitor is entitled to, so it is
 * never served to an anonymous lookup.
 */
export const mediaInspections = pgTable(
  'media_inspections',
  {
    id: uuid('id').primaryKey(),
    normalizedUrlHash: text('normalized_url_hash').notNull(),
    platform: platformEnum('platform').notNull(),
    requiredAuth: boolean('required_auth').notNull().default(false),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_inspections_hash_auth_key').on(table.normalizedUrlHash, table.requiredAuth),
    index('media_inspections_expires_at_idx').on(table.expiresAt),
  ],
);

export type MediaInspectionRow = typeof mediaInspections.$inferSelect;
export type NewMediaInspectionRow = typeof mediaInspections.$inferInsert;
