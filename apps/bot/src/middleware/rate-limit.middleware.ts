import { describeError } from '@tgtools/shared';
import type { AppContext } from '@tgtools/telegram';
import type { Middleware } from 'grammy';
import type { Redis } from 'ioredis';

export interface RateLimitOptions {
  readonly redis: Redis;
  readonly windowMs: number;
  readonly maxRequests: number;
}

const THROTTLED_MESSAGE = '🚦 کمی آهسته‌تر! چند لحظه صبر کنید و دوباره تلاش کنید.';

/**
 * A fixed-window counter per user, in Redis so the limit holds across replicas.
 *
 * Fails open. A rate limiter whose backing store is down should not become an
 * outage of its own — the per-user job limit downstream still bounds the real
 * cost, and that one reads from Postgres.
 */
export function rateLimit({
  redis,
  windowMs,
  maxRequests,
}: RateLimitOptions): Middleware<AppContext> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      await next();
      return;
    }

    const key = `ratelimit:updates:${userId}`;
    let count: number;
    try {
      count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, windowMs);
    } catch (error: unknown) {
      ctx.logger.warn('rate limiter unavailable; allowing the update', {
        error: describeError(error),
      });
      await next();
      return;
    }

    if (count > maxRequests) {
      // Only the first update over the line gets a reply. Answering all of them
      // would turn a burst into a second burst, in the other direction.
      if (count === maxRequests + 1) await ctx.reply(THROTTLED_MESSAGE);
      ctx.logger.debug('update dropped by the rate limiter', { count });
      return;
    }

    await next();
  };
}
