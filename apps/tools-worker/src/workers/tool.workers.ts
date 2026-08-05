import { QueueName, createWorker } from '@tgtools/queue';
import { ToolFamily } from '@tgtools/shared';
import type { ToolFamily as ToolFamilyType } from '@tgtools/shared';
import type { Worker } from 'bullmq';
import type { ToolsWorkerContainer } from '../container.js';
import { createToolProcessor } from '../processors/tool.processor.js';

/**
 * One BullMQ consumer per family, not one for all four.
 *
 * The split is the entire reason `QueueName` has four tool entries. A 30-minute
 * PDF render sharing a queue with QR generation would leave a user waiting
 * minutes for an operation that takes 40 ms — and concurrency is the other half
 * of it: video runs one at a time because two ffmpeg processes on a shared host
 * make both slower than either alone, while QR runs four because it is pure CPU
 * for a few milliseconds.
 */

interface FamilyWiring {
  readonly family: ToolFamilyType;
  readonly queue: QueueName;
  readonly concurrency: number;
  readonly enabled: boolean;
}

function wiringFor(container: ToolsWorkerContainer): readonly FamilyWiring[] {
  const tools = container.config.tools;
  return [
    {
      family: ToolFamily.Image,
      queue: QueueName.ToolImage,
      concurrency: tools.image.concurrency,
      enabled: tools.imageEnabled,
    },
    {
      family: ToolFamily.Video,
      queue: QueueName.ToolVideo,
      concurrency: tools.video.concurrency,
      enabled: tools.videoEnabled,
    },
    {
      family: ToolFamily.Pdf,
      queue: QueueName.ToolPdf,
      concurrency: tools.pdf.concurrency,
      enabled: tools.pdfEnabled,
    },
    {
      family: ToolFamily.Qr,
      queue: QueueName.ToolQr,
      concurrency: tools.qr.concurrency,
      enabled: tools.qrEnabled,
    },
  ];
}

/**
 * Start a consumer for each ENABLED family.
 *
 * A disabled family gets no consumer at all, rather than a consumer that
 * rejects what it reads. The difference matters during an incident: with no
 * consumer the jobs wait in Redis and run when the family is turned back on;
 * with a rejecting one they burn their attempt budget and fail permanently.
 */
export function startToolWorkers(container: ToolsWorkerContainer): readonly Worker<unknown>[] {
  const processor = createToolProcessor(container);
  const started: Worker<unknown>[] = [];

  for (const wiring of wiringFor(container)) {
    if (!wiring.enabled) {
      container.logger.warn('tool family is disabled; its queue will not be drained', {
        family: wiring.family,
        queue: wiring.queue,
      });
      continue;
    }

    started.push(
      createWorker<unknown>({
        name: wiring.queue,
        connection: container.redis.client,
        config: container.config,
        concurrency: wiring.concurrency,
        processor,
        logger: container.logger,
        overrides: {
          // The tools have their own lock duration: a fifty-page render holds
          // its lock far longer than a download does, and inheriting the
          // downloader's value would have BullMQ declare a healthy job stalled
          // and hand it to a second worker — which then renders it again.
          lockDuration: container.config.tools.queue.lockDurationMs,
          stalledInterval: Math.floor(container.config.tools.queue.lockDurationMs / 2),
        },
      }),
    );

    container.logger.info('tool worker started', {
      family: wiring.family,
      queue: wiring.queue,
      concurrency: wiring.concurrency,
    });
  }

  return started;
}
