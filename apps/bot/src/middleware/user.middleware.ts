import type { RegisterOrUpdateUserUseCase } from '@tgtools/feature-users';
import { describeError } from '@tgtools/shared';
import type { AppContext } from '@tgtools/telegram';
import type { Middleware } from 'grammy';

export interface UserMiddlewareOptions {
  readonly registerOrUpdateUser: RegisterOrUpdateUserUseCase;
}

const BLOCKED_MESSAGE = '⛔️ دسترسی شما به این ربات محدود شده است.';

/**
 * Resolves the Telegram sender into an application user and puts it on the
 * context.
 *
 * Runs before every feature, so from here on a handler can rely on `ctx.user`
 * existing. Updates with no sender — channel posts, some service messages —
 * are dropped rather than given a synthetic identity.
 */
export function userContext({
  registerOrUpdateUser,
}: UserMiddlewareOptions): Middleware<AppContext> {
  return async (ctx, next) => {
    const from = ctx.from;
    if (from === undefined || from.is_bot) return;

    try {
      const user = await registerOrUpdateUser.execute({
        telegramUserId: from.id,
        username: from.username,
        firstName: from.first_name,
        languageCode: from.language_code,
      });

      if (user.isBlocked) {
        ctx.logger.info('ignoring update from a blocked user');
        await ctx.reply(BLOCKED_MESSAGE);
        return;
      }

      ctx.user = {
        id: user.id,
        telegramUserId: user.telegramUserId,
        languageCode: user.languageCode,
        isBlocked: user.isBlocked,
      };
      await next();
    } catch (error: unknown) {
      // A database blip must not silently swallow the update: log it and let
      // the error boundary above produce a message the user can act on.
      ctx.logger.error('failed to resolve the user for this update', {
        error: describeError(error),
      });
      throw error;
    }
  };
}
