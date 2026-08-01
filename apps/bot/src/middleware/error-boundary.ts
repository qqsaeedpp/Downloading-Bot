import { describeError } from '@tgtools/shared';
import type { Logger } from '@tgtools/shared';
import type { AppContext } from '@tgtools/telegram';
import { classifyTelegramError } from '@tgtools/telegram';
import type { ErrorHandler } from 'grammy';

const GENERIC_FAILURE = '⚠️ مشکلی پیش آمد. کمی بعد دوباره تلاش کنید.';

/**
 * The last line of defence.
 *
 * An unhandled rejection inside a grammY handler would otherwise take the
 * process down, losing every other in-flight update with it. Here it becomes
 * one logged error and one apologetic message.
 */
export function createErrorBoundary(logger: Logger): ErrorHandler<AppContext> {
  return async (error) => {
    const ctx = error.ctx;
    const contextLogger = ctx.logger ?? logger;

    const info = classifyTelegramError(error.error);
    // The user blocked the bot, or deleted the chat. Nothing is wrong on our
    // side and there is nobody left to apologise to.
    if (info.kind === 'blocked_by_user' || info.kind === 'chat_not_found') {
      contextLogger.info('update abandoned: the chat is unreachable', { kind: info.kind });
      return;
    }

    contextLogger.error('unhandled error while processing an update', {
      updateId: ctx.update.update_id,
      kind: info.kind,
      error: describeError(error.error),
    });

    try {
      await ctx.reply(GENERIC_FAILURE);
    } catch (replyError: unknown) {
      // If even the apology fails there is nothing further to try; saying so
      // beats a second unhandled rejection.
      contextLogger.debug('could not deliver the failure message', {
        error: describeError(replyError),
      });
    }
  };
}
