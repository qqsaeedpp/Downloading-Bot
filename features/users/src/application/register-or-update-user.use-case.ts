import type { Logger } from '@tgtools/shared';
import type { AppUser, UserRepository } from '../domain/user.js';

export interface RegisterOrUpdateUserCommand {
  readonly telegramUserId: number;
  readonly username: string | undefined;
  readonly firstName: string | undefined;
  readonly languageCode: string | undefined;
}

export interface RegisterOrUpdateUserDependencies {
  readonly users: UserRepository;
  readonly logger: Logger;
}

/**
 * Runs on every update, so it has to be one round trip and nothing more.
 * Anything heavier here is paid for by every message the bot ever receives.
 */
export class RegisterOrUpdateUserUseCase {
  constructor(private readonly deps: RegisterOrUpdateUserDependencies) {}

  async execute(command: RegisterOrUpdateUserCommand): Promise<AppUser> {
    return this.deps.users.upsert({
      telegramUserId: command.telegramUserId,
      username: command.username,
      firstName: command.firstName,
      languageCode: command.languageCode,
    });
  }
}
