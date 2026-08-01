import type { Db } from '@tgtools/database';
import { users } from '@tgtools/database';
import type { Clock, IdGenerator } from '@tgtools/shared';
import { InvariantViolationError } from '@tgtools/shared';
import { eq } from 'drizzle-orm';
import type { AppUser, UpsertUserInput, UserRepository } from '../domain/user.js';
import type { UserRow } from '@tgtools/database';

export class DrizzleUserRepository implements UserRepository {
  constructor(
    private readonly db: Db,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async upsert(input: UpsertUserInput): Promise<AppUser> {
    const now = this.clock.now();
    const [row] = await this.db
      .insert(users)
      .values({
        id: this.ids.uuid(),
        telegramUserId: input.telegramUserId,
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        languageCode: input.languageCode ?? null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: users.telegramUserId,
        set: {
          // Profile fields are refreshed because they change; `isBlocked` and
          // `createdAt` deliberately are not, or a user could clear a block by
          // sending another message.
          username: input.username ?? null,
          firstName: input.firstName ?? null,
          languageCode: input.languageCode ?? null,
          updatedAt: now,
          lastSeenAt: now,
        },
      })
      .returning();

    if (row === undefined) {
      throw new InvariantViolationError('User upsert returned no row');
    }
    return toAppUser(row);
  }

  async findByTelegramId(telegramUserId: number): Promise<AppUser | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);
    return row === undefined ? undefined : toAppUser(row);
  }

  async setBlocked(userId: string, blocked: boolean): Promise<void> {
    await this.db
      .update(users)
      .set({ isBlocked: blocked, updatedAt: this.clock.now() })
      .where(eq(users.id, userId));
  }
}

function toAppUser(row: UserRow): AppUser {
  return {
    id: row.id,
    telegramUserId: row.telegramUserId,
    username: row.username ?? undefined,
    firstName: row.firstName ?? undefined,
    languageCode: row.languageCode ?? undefined,
    isBlocked: row.isBlocked,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}
