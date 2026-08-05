import { QueueName } from '@tgtools/queue';
import type { ToolFamily } from '@tgtools/shared';
import { toolFamilyOf } from '@tgtools/shared';
import type { ToolJobPayload } from '@tgtools/tool-contracts';
import type { Queue } from 'bullmq';
import type { ToolQueuePort } from '../../domain/ports/supporting-ports.js';

/**
 * Routes a job to its family's queue.
 *
 * Four queues rather than one, because the families contend for different
 * resources: a thirty-minute PDF render sharing a queue with QR generation
 * would leave a user waiting minutes for an operation that takes 40 ms. The
 * family is DERIVED from the tool key rather than carried alongside it, so a job
 * cannot be queued as one kind of work and executed as another.
 */

/** Which BullMQ queue each family's work goes on. Mirrors the worker's consumers. */
export const QUEUE_FOR_FAMILY: Readonly<Record<ToolFamily, QueueName>> = {
  image: QueueName.ToolImage,
  video: QueueName.ToolVideo,
  pdf: QueueName.ToolPdf,
  qr: QueueName.ToolQr,
};

export class BullMqToolQueue implements ToolQueuePort {
  constructor(private readonly queues: Readonly<Record<ToolFamily, Queue<ToolJobPayload>>>) {}

  async enqueue(payload: ToolJobPayload): Promise<void> {
    const family = toolFamilyOf(payload.tool);
    const queue = this.queues[family];

    // The job's own id, not a generated one. A duplicate delivery of the same
    // job is then a no-op in BullMQ rather than a second conversion billed to
    // the same user.
    await queue.add(payload.tool, payload, { jobId: payload.jobId });
  }
}
