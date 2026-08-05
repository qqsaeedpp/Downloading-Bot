import { TOOL_SESSION_SCHEMA_VERSION, toolSessionKey } from '@tgtools/tool-contracts';
import type { ToolSession } from '@tgtools/tool-contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { RedisToolSessionStore } from './redis-tool-session-store.js';

/** Just enough ioredis: a string map that remembers the TTL it was given. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly deleted: string[] = [];

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    this.values.set(key, value);
    if (mode === 'EX' && ttl !== undefined) this.ttls.set(key, ttl);
    return Promise.resolve('OK');
  }

  del(key: string): Promise<number> {
    this.deleted.push(key);
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }
}

function storeWith(redis: FakeRedis, ttlSeconds = 900) {
  return new RedisToolSessionStore({
    redis: redis as unknown as Redis,
    botId: 'bot-7',
    ttlSeconds,
  });
}

const AWAITING: ToolSession = {
  schemaVersion: TOOL_SESSION_SCHEMA_VERSION,
  tool: 'image.compress',
  createdAtMs: 1_000,
  state: 'awaiting_input',
};

describe('RedisToolSessionStore', () => {
  it('round-trips a session', async () => {
    const redis = new FakeRedis();
    const store = storeWith(redis);

    await store.save(42, AWAITING);
    expect(await store.load(42)).toEqual(AWAITING);
  });

  it('scopes the key by bot id as well as user id', async () => {
    // A staging bot beside production is the normal deployment, and they share
    // a Redis. Without the bot id one user would see the other bot's flow.
    const redis = new FakeRedis();
    await storeWith(redis).save(42, AWAITING);

    expect([...redis.values.keys()]).toEqual([toolSessionKey('bot-7', 42)]);
  });

  it('gives every session an expiry', async () => {
    // A user who abandons a flow halfway must not leave state in Redis
    // forever, and every one of these keys is per-user.
    const redis = new FakeRedis();
    await storeWith(redis, 600).save(42, AWAITING);

    expect(redis.ttls.get(toolSessionKey('bot-7', 42))).toBe(600);
  });

  it('reports no session rather than throwing when nothing is stored', async () => {
    expect(await storeWith(new FakeRedis()).load(42)).toBeUndefined();
  });

  it('discards a session written by a release this build cannot read', async () => {
    // Routine during a rolling deploy. The only safe response to a shape we no
    // longer understand is to drop it and restart the flow — raising here would
    // fail the user's next message instead.
    const redis = new FakeRedis();
    redis.values.set(
      toolSessionKey('bot-7', 42),
      JSON.stringify({ ...AWAITING, schemaVersion: 99 }),
    );

    expect(await storeWith(redis).load(42)).toBeUndefined();
  });

  it('discards outright corruption without throwing', async () => {
    const redis = new FakeRedis();
    for (const bad of ['', 'not json', '{"half":', 'null', '[]']) {
      redis.values.set(toolSessionKey('bot-7', 42), bad);
      await expect(storeWith(redis).load(42)).resolves.toBeUndefined();
    }
  });

  it('clears a session when the flow ends', async () => {
    // Left behind, it would make the user's next unrelated photo look like an
    // input to a tool they finished with ten minutes ago.
    const redis = new FakeRedis();
    const store = storeWith(redis);

    await store.save(42, AWAITING);
    await store.clear(42);

    expect(await store.load(42)).toBeUndefined();
    expect(redis.deleted).toEqual([toolSessionKey('bot-7', 42)]);
  });

  it('refuses to save a session the schema would reject', async () => {
    // Writing an invalid session is a bug that only shows up on the NEXT
    // message, as a flow that mysteriously restarted. Failing at the write puts
    // the error where the mistake is.
    const store = storeWith(new FakeRedis());
    const broken = { ...AWAITING, state: 'inventing_things' } as unknown as ToolSession;

    await expect(store.save(42, broken)).rejects.toThrow();
  });

  it('survives Redis being unavailable on read', async () => {
    // A user's message must not fail because the session cache is down; the
    // honest fallback is "no session", which restarts the flow.
    const redis = new FakeRedis();
    redis.get = () => Promise.reject(new Error('redis is down'));

    await expect(storeWith(redis).load(42)).resolves.toBeUndefined();
  });
});
