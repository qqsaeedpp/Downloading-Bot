import type { IdGenerator, Logger } from '@tgtools/shared';
import type { AppContext } from '@tgtools/telegram';
import type { Middleware } from 'grammy';

export interface RequestContextOptions {
  readonly logger: Logger;
  readonly ids: IdGenerator;
}

/**
 * Stamps every update with an id and a scoped logger.
 *
 * The same id travels into the job payload and out the other side in the
 * worker, which is the only practical way to follow one user's request across
 * two processes and twenty minutes of elapsed time.
 */
export function requestContext({ logger, ids }: RequestContextOptions): Middleware<AppContext> {
  return async (ctx, next) => {
    const requestId = ids.short(8);
    ctx.requestId = requestId;
    ctx.logger = logger.child({
      requestId,
      updateId: ctx.update.update_id,
      telegramUserId: ctx.from?.id,
    });
    await next();
  };
}
