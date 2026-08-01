import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import type { Redis } from 'ioredis';
import type { DownloadCancellationBus } from '../../domain/ports/supporting-ports.js';

export const CANCEL_CHANNEL = 'tgtools:download:cancel';

export interface RedisCancellationBusOptions {
  /** For publishing. Shares the ordinary command connection. */
  readonly publisher: Redis;
  /**
   * For subscribing. MUST be its own connection: a Redis client in subscriber
   * mode refuses every other command, so sharing one would break the queue.
   * Only the worker needs this.
   */
  readonly subscriber?: Redis;
  readonly logger: Logger;
}

/**
 * Broadcasts "stop job X" to every worker.
 *
 * Pub/sub rather than a queue on purpose: the message is worthless a second
 * after it is sent, only the worker currently holding that job cares, and if
 * nobody is listening there is nothing to deliver later. Delivery is
 * best-effort, and that is fine — the job's `cancelled` status is the durable
 * record, so a missed message costs a download that finishes and is discarded,
 * not a wrong outcome.
 */
export class RedisCancellationBus implements DownloadCancellationBus {
  constructor(private readonly options: RedisCancellationBusOptions) {}

  async publishCancel(jobId: string): Promise<void> {
    try {
      await this.options.publisher.publish(CANCEL_CHANNEL, jobId);
    } catch (error: unknown) {
      this.options.logger.warn('could not broadcast the cancellation', {
        jobId,
        error: describeError(error),
      });
    }
  }

  async subscribeCancel(handler: (jobId: string) => void): Promise<() => Promise<void>> {
    const subscriber = this.options.subscriber;
    if (subscriber === undefined) {
      throw new Error('RedisCancellationBus was constructed without a subscriber connection');
    }

    const onMessage = (channel: string, message: string): void => {
      if (channel !== CANCEL_CHANNEL) return;
      handler(message);
    };

    subscriber.on('message', onMessage);
    await subscriber.subscribe(CANCEL_CHANNEL);
    this.options.logger.debug('subscribed to download cancellations');

    return async () => {
      subscriber.off('message', onMessage);
      await subscriber.unsubscribe(CANCEL_CHANNEL);
    };
  }
}
