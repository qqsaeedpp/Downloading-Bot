export interface AppUser {
  readonly id: string;
  readonly telegramUserId: number;
  readonly username: string | undefined;
  readonly firstName: string | undefined;
  readonly languageCode: string | undefined;
  readonly isBlocked: boolean;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface UpsertUserInput {
  readonly telegramUserId: number;
  readonly username: string | undefined;
  readonly firstName: string | undefined;
  readonly languageCode: string | undefined;
}

export interface UserRepository {
  /**
   * Insert or refresh in one statement.
   *
   * Every update the bot receives passes through here, so a read-then-write
   * would both double the round trips and race with itself when a user sends
   * two messages at once.
   */
  upsert(input: UpsertUserInput): Promise<AppUser>;
  findByTelegramId(telegramUserId: number): Promise<AppUser | undefined>;
  setBlocked(userId: string, blocked: boolean): Promise<void>;
}
