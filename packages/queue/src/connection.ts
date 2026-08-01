import type { AppConfig } from '@tgtools/config';
import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import { Redis } from 'ioredis';

export interface RedisHandle {
  readonly client: Redis;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * BullMQ blocks on `BRPOPLPUSH` for its whole poll interval. ioredis's default
 * `maxRetriesPerRequest` counts that as a stalled command and tears the
 * connection down, so BullMQ requires the retry cap to be disabled outright.
 * This is a hard requirement of the library, not a tuning choice.
 */
const BULLMQ_REQUIRED_OPTIONS = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
} as const;

export interface CreateRedisOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Label for the log lines, e.g. `producer` or `worker`. */
  readonly role: string;
}

export function createRedis({ config, logger, role }: CreateRedisOptions): RedisHandle {
  const client = new Redis(config.redis.url, {
    ...BULLMQ_REQUIRED_OPTIONS,
    lazyConnect: false,
    // Back off instead of hammering a Redis that is still starting up.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    connectionName: `tgtools-${role}`,
  });

  client.on('error', (error: unknown) => {
    // ioredis reconnects on its own; logging at error level without exiting is
    // the correct response, since a transient blip must not kill the process.
    logger.error('redis connection error', { role, error: describeError(error) });
  });
  client.on('reconnecting', () => {
    logger.warn('redis reconnecting', { role });
  });

  return {
    client,
    async ping(): Promise<void> {
      const reply: string = await client.ping();
      if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${reply}`);
    },
    async close(): Promise<void> {
      try {
        await client.quit();
      } catch {
        // `quit` fails if the socket is already gone; `disconnect` is then the
        // only thing left that can release the handle.
        client.disconnect();
      }
      logger.debug('redis connection closed', { role });
    },
  };
}
