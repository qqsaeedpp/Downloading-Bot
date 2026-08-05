import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import type { Redis } from 'ioredis';
import type { ToolCancellationBus } from '../../domain/ports/supporting-ports.js';

/**
 * Its own channel, not the downloader's.
 *
 * Both buses run against the same Redis and both carry UUIDs, so a shared name
 * would make every download cancellation also attempt to cancel a tool job —
 * and one day the ids would collide.
 */
export const TOOL_CANCEL_CHANNEL = 'tgtools:tool:cancel';

export interface RedisToolCancellationBusOptions {
  /** For publishing. Shares the ordinary command connection. */
  readonly publisher: Redis;
  /**
   * For subscribing. MUST be its own connection: a Redis client in subscriber
   * mode refuses every other command, so sharing one would break the queue.
   * Only the tools worker needs this.
   */
  readonly subscriber?: Redis;
  readonly logger: Logger;
}

/**
 * Broadcasts "stop job X" to whichever tools worker is running it.
 *
 * Pub/sub rather than a queue: the message is worthless a second after it is
 * sent, only the worker currently holding that job cares, and if nobody is
 * listening there is nothing worth delivering later. The `cancelled` row is the
 * durable record, so a missed message costs a conversion that finishes and is
 * discarded — not a wrong outcome.
 */
export class RedisToolCancellationBus implements ToolCancellationBus {
  constructor(private readonly options: RedisToolCancellationBusOptions) {}

  async publishCancel(jobId: string): Promise<void> {
    try {
      await this.options.publisher.publish(TOOL_CANCEL_CHANNEL, jobId);
    } catch (error: unknown) {
      // Swallowed deliberately. The caller is a user tapping "cancel", the row
      // has already been written, and turning a successful cancellation into an
      // error message would be a worse answer than a conversion that runs to
      // completion and is thrown away.
      this.options.logger.warn('could not broadcast the tool cancellation', {
        jobId,
        error: describeError(error),
      });
    }
  }

  async subscribeCancel(handler: (jobId: string) => void): Promise<() => Promise<void>> {
    const subscriber = this.options.subscriber;
    if (subscriber === undefined) {
      throw new Error('RedisToolCancellationBus was constructed without a subscriber connection');
    }

    const onMessage = (channel: string, message: string): void => {
      // ioredis emits `message` for every channel the connection carries, not
      // just ours.
      if (channel !== TOOL_CANCEL_CHANNEL) return;
      handler(message);
    };

    subscriber.on('message', onMessage);
    await subscriber.subscribe(TOOL_CANCEL_CHANNEL);
    this.options.logger.debug('subscribed to tool cancellations');

    return async () => {
      // Detach before unsubscribing: the connection outlives the subscription
      // during a graceful shutdown, and a listener left attached keeps firing
      // into a registry that has already been torn down.
      subscriber.off('message', onMessage);
      await subscriber.unsubscribe(TOOL_CANCEL_CHANNEL);
    };
  }
}
