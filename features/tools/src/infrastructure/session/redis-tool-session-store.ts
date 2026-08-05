import { InvariantViolationError } from '@tgtools/shared';
import { parseToolSession, toolSessionKey, toolSessionSchema } from '@tgtools/tool-contracts';
import type { ToolSession } from '@tgtools/tool-contracts';
import type { Redis } from 'ioredis';

/**
 * One user's half-finished tool flow, kept in Redis.
 *
 * In Redis rather than in the bot's memory for a reason that shows up the first
 * time a deployment rolls: a user halfway through "send me your photos" would
 * otherwise find the bot had forgotten them, with no message and no way to
 * recover except starting over. It also stops two bot replicas disagreeing
 * about what one user is doing.
 *
 * Reads are FORGIVING and writes are STRICT, deliberately. A stored session
 * that no longer parses — written by an older release, truncated, hand-edited —
 * is indistinguishable from no session at all as far as the user's next action
 * goes, so it is discarded quietly. An invalid session being WRITTEN is a bug in
 * this build, and surfacing it at the write is the difference between a stack
 * trace pointing at the mistake and a flow that mysteriously restarts one
 * message later.
 */

export interface RedisToolSessionStoreOptions {
  readonly redis: Redis;
  /**
   * Scopes every key. A staging bot beside production is the normal deployment
   * and they share a Redis; without this, one user would see the other bot's
   * conversation.
   */
  readonly botId: string;
  readonly ttlSeconds: number;
}

export class RedisToolSessionStore {
  constructor(private readonly options: RedisToolSessionStoreOptions) {}

  #key(telegramUserId: number): string {
    return toolSessionKey(this.options.botId, telegramUserId);
  }

  /** Never throws. Anything unreadable reads as "no session in progress". */
  async load(telegramUserId: number): Promise<ToolSession | undefined> {
    try {
      return parseToolSession(await this.options.redis.get(this.#key(telegramUserId)));
    } catch {
      // Redis itself is unavailable. The user's message must not fail because a
      // cache is down; restarting the flow is a worse outcome than a crash only
      // in theory.
      return undefined;
    }
  }

  async save(telegramUserId: number, session: ToolSession): Promise<void> {
    const validated = toolSessionSchema.safeParse(session);
    if (!validated.success) {
      throw new InvariantViolationError(
        'refusing to store a tool session that does not match the schema',
        { context: { issue: validated.error.issues[0]?.message ?? 'unknown' } },
      );
    }

    // Always with an expiry. A user who abandons a flow halfway would otherwise
    // leave state in Redis forever, and there is one of these keys per user.
    await this.options.redis.set(
      this.#key(telegramUserId),
      JSON.stringify(validated.data),
      'EX',
      this.options.ttlSeconds,
    );
  }

  /**
   * Ends the flow.
   *
   * Called on completion and on cancellation alike. A session left behind makes
   * the user's next, unrelated photo look like an input to a tool they finished
   * with ten minutes ago.
   */
  async clear(telegramUserId: number): Promise<void> {
    await this.options.redis.del(this.#key(telegramUserId));
  }
}
