import type { AppConfig } from '@tgtools/config';
import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import { Queue, Worker } from 'bullmq';
import type { JobsOptions, Processor, WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { QueueName } from './queue-names.js';

/**
 * Defaults every job inherits.
 *
 * `removeOnComplete`/`removeOnFail` are set with both an age and a count: age
 * alone lets a burst pin gigabytes in Redis for an hour, and count alone lets a
 * quiet week keep records nobody will read. Leaving them unset — which is the
 * BullMQ default — grows the sorted sets without bound until Redis evicts
 * something that mattered.
 */
export function defaultJobOptions(config: AppConfig): JobsOptions {
  return {
    attempts: config.queue.attempts,
    backoff: { type: 'exponential', delay: config.queue.backoffMs },
    removeOnComplete: { age: config.queue.removeCompleteAfterSeconds, count: 1_000 },
    removeOnFail: { age: config.queue.removeFailAfterSeconds, count: 5_000 },
  };
}

export interface CreateQueueOptions {
  readonly name: QueueName;
  readonly connection: Redis;
  readonly config: AppConfig;
}

export function createQueue<TPayload extends object>({
  name,
  connection,
  config,
}: CreateQueueOptions): Queue<TPayload> {
  return new Queue<TPayload>(name, {
    connection,
    defaultJobOptions: defaultJobOptions(config),
  });
}

export interface CreateWorkerOptions<TPayload> {
  readonly name: QueueName;
  readonly connection: Redis;
  readonly config: AppConfig;
  readonly concurrency: number;
  readonly processor: Processor<TPayload>;
  readonly logger: Logger;
  readonly overrides?: Partial<WorkerOptions>;
}

export function createWorker<TPayload>({
  name,
  connection,
  config,
  concurrency,
  processor,
  logger,
  overrides,
}: CreateWorkerOptions<TPayload>): Worker<TPayload> {
  const worker = new Worker<TPayload>(name, processor, {
    connection,
    concurrency,
    // A download holds its lock for minutes. BullMQ renews at half the duration
    // while the processor is alive, so this only has to exceed the longest gap
    // between event-loop turns — but set too low, a healthy job is declared
    // stalled and handed to a second worker, and the file gets fetched twice.
    lockDuration: config.queue.lockDurationMs,
    stalledInterval: Math.floor(config.queue.lockDurationMs / 2),
    // One free recovery after a hard crash; a job that stalls repeatedly is a
    // bug, and retrying it forever only spreads the damage.
    maxStalledCount: 1,
    ...overrides,
  });

  worker.on('failed', (job, error) => {
    logger.error('job failed', {
      queue: name,
      jobId: job?.id,
      attempt: job?.attemptsMade,
      error: describeError(error),
    });
  });
  worker.on('error', (error) => {
    logger.error('worker error', { queue: name, error: describeError(error) });
  });
  worker.on('stalled', (jobId) => {
    logger.warn('job stalled', { queue: name, jobId });
  });

  return worker;
}
