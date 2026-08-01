import type { Clock, Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import type { Redis } from 'ioredis';
import type { DownloadJobRepository } from '../../domain/ports/download-job.repository.js';
import type { DownloadAccessPolicy } from '../../domain/ports/supporting-ports.js';

export interface DefaultAccessPolicyOptions {
  readonly jobs: DownloadJobRepository;
  readonly redis: Redis;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxActiveJobsPerUser: number;
  readonly inspectWindowMs: number;
  readonly inspectMaxPerWindow: number;
}

/**
 * The phase-one answer to "who may do what": everyone, within limits.
 *
 * Written against the port from the start so that a plan, a subscription or an
 * operator allow-list can be dropped in later without a single use case
 * changing — they already ask the question.
 */
export class DefaultDownloadAccessPolicy implements DownloadAccessPolicy {
  constructor(private readonly options: DefaultAccessPolicyOptions) {}

  /**
   * Inspection is cheap but not free: each one spawns a process and hits a
   * third party. The counter lives in Redis so the limit holds across bot
   * replicas, and it fails open — a Redis outage should not lock everyone out.
   */
  async canInspect(userId: string): Promise<boolean> {
    const key = `ratelimit:inspect:${userId}`;
    try {
      const count = await this.options.redis.incr(key);
      if (count === 1) {
        await this.options.redis.pexpire(key, this.options.inspectWindowMs);
      }
      return count <= this.options.inspectMaxPerWindow;
    } catch (error: unknown) {
      this.options.logger.warn('inspect rate limiter unavailable; allowing the request', {
        error: describeError(error),
      });
      return true;
    }
  }

  /**
   * Downloads are limited by *concurrency*, not by rate. One user should not be
   * able to occupy every worker slot, but nothing stops them queueing a hundred
   * over an afternoon.
   */
  async canCreateDownload(userId: string): Promise<boolean> {
    const active = await this.options.jobs.countActiveByUser(userId);
    return active < this.options.maxActiveJobsPerUser;
  }

  getActiveJobLimit(): Promise<number> {
    return Promise.resolve(this.options.maxActiveJobsPerUser);
  }
}
