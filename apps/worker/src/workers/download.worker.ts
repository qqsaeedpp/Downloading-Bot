import { QueueName, createWorker } from '@tgtools/queue';
import type { Worker } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import { createDownloadProcessor } from '../processors/download.processor.js';

export function startDownloadWorker(container: WorkerContainer): Worker<unknown> {
  const worker = createWorker<unknown>({
    name: QueueName.MediaDownload,
    connection: container.redis.client,
    config: container.config,
    concurrency: container.config.queue.downloadConcurrency,
    processor: createDownloadProcessor(container),
    logger: container.logger,
  });

  container.logger.info('download worker started', {
    concurrency: container.config.queue.downloadConcurrency,
    lockDurationMs: container.config.queue.lockDurationMs,
  });

  return worker;
}
