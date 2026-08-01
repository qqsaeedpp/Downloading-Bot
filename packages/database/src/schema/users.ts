import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /**
     * Telegram ids already exceed 32 bits and are documented as fitting in 52,
     * so `bigint` with JS-number mode is both correct and safe to compare in
     * application code.
     */
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    username: text('username'),
    firstName: text('first_name'),
    languageCode: text('language_code'),
    isBlocked: boolean('is_blocked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('users_telegram_user_id_key').on(table.telegramUserId),
    index('users_last_seen_at_idx').on(table.lastSeenAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
