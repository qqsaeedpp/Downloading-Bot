import { createNoopLogger } from '@tgtools/shared';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { TOOL_CANCEL_CHANNEL, RedisToolCancellationBus } from './redis-tool-cancellation-bus.js';

/**
 * Just enough ioredis to exercise the subscription: a message emitter with the
 * three methods the bus calls. A real Redis would test ioredis, not this.
 */
class FakeRedis {
  readonly published: { channel: string; message: string }[] = [];
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  #handlers: ((channel: string, message: string) => void)[] = [];

  publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return Promise.resolve(1);
  }

  subscribe(channel: string): Promise<number> {
    this.subscribed.push(channel);
    return Promise.resolve(1);
  }

  unsubscribe(channel: string): Promise<number> {
    this.unsubscribed.push(channel);
    return Promise.resolve(1);
  }

  on(event: string, handler: (channel: string, message: string) => void): this {
    if (event === 'message') this.#handlers.push(handler);
    return this;
  }

  off(event: string, handler: (channel: string, message: string) => void): this {
    if (event === 'message') this.#handlers = this.#handlers.filter((h) => h !== handler);
    return this;
  }

  /** Simulate Redis delivering a message. */
  deliver(channel: string, message: string): void {
    for (const handler of this.#handlers) handler(channel, message);
  }

  get listenerCount(): number {
    return this.#handlers.length;
  }
}

function busWith(publisher: FakeRedis, subscriber: FakeRedis) {
  return new RedisToolCancellationBus({
    publisher: publisher as unknown as Redis,
    subscriber: subscriber as unknown as Redis,
    logger: createNoopLogger(),
  });
}

describe('RedisToolCancellationBus', () => {
  it('delivers a cancellation for its own channel', async () => {
    const redis = new FakeRedis();
    const seen: string[] = [];

    await busWith(redis, redis).subscribeCancel((jobId) => seen.push(jobId));
    redis.deliver(TOOL_CANCEL_CHANNEL, 'job-1');

    expect(seen).toEqual(['job-1']);
  });

  it('ignores traffic on every other channel', async () => {
    // ioredis emits `message` for EVERY channel the connection is subscribed
    // to. Without the filter, a download cancellation would abort a tool job
    // that happened to share an id-shaped string — and the two id spaces are
    // both UUIDs.
    const redis = new FakeRedis();
    const seen: string[] = [];

    await busWith(redis, redis).subscribeCancel((jobId) => seen.push(jobId));
    redis.deliver('tgtools:download:cancel', 'job-1');
    redis.deliver('some:other:channel', 'job-2');

    expect(seen).toEqual([]);
  });

  it('does not share a channel with the downloader', () => {
    // Both buses run against the same Redis. A shared channel name would make
    // every download cancellation also try to cancel a tool job.
    expect(TOOL_CANCEL_CHANNEL).not.toBe('tgtools:download:cancel');
  });

  it('removes its listener on unsubscribe, so a restart cannot double-handle', async () => {
    // The subscriber connection outlives the subscription during a graceful
    // shutdown. A listener left attached would keep firing into a handler whose
    // registry has already been torn down.
    const redis = new FakeRedis();
    const seen: string[] = [];

    const unsubscribe = await busWith(redis, redis).subscribeCancel((jobId) => seen.push(jobId));
    expect(redis.listenerCount).toBe(1);

    await unsubscribe();
    redis.deliver(TOOL_CANCEL_CHANNEL, 'job-1');

    expect(redis.listenerCount).toBe(0);
    expect(seen).toEqual([]);
    expect(redis.unsubscribed).toEqual([TOOL_CANCEL_CHANNEL]);
  });

  it('never lets a publish failure escape into the caller', async () => {
    // The caller is a user tapping "cancel". The durable record is the
    // `cancelled` row, which has already been written; failing here would turn
    // a successful cancellation into an error message.
    const failing = new FakeRedis();
    failing.publish = () => Promise.reject(new Error('redis is down'));

    await expect(busWith(failing, failing).publishCancel('job-1')).resolves.toBeUndefined();
  });

  it('refuses to subscribe without a dedicated connection', async () => {
    // A client in subscriber mode rejects every other command. Sharing the
    // queue's connection would break the queue, silently, at the moment the
    // first cancellation arrived.
    const bus = new RedisToolCancellationBus({
      publisher: new FakeRedis() as unknown as Redis,
      logger: createNoopLogger(),
    });

    await expect(bus.subscribeCancel(() => undefined)).rejects.toThrow(/subscriber/i);
  });
});
