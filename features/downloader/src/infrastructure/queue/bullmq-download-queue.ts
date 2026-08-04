import type { Logger } from '@tgtools/shared';
import { DOWNLOAD_TYPE_VALUES, MEDIA_PLATFORM_VALUES, describeError } from '@tgtools/shared';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import type { DownloadJobPayload, DownloadQueuePort } from '../../domain/ports/supporting-ports.js';

export const DOWNLOAD_JOB_NAME = 'download';

/**
 * The payload is validated on the way *out* of the queue as well as in.
 *
 * A message sits in Redis across deploys, so the worker that reads it may be a
 * different version from the bot that wrote it. Parsing here means a shape
 * change surfaces as one rejected job rather than a `TypeError` deep inside the
 * download pipeline.
 */
export const downloadJobPayloadSchema = z.object({
  jobId: z.string().min(1),
  requestId: z.string().min(1),
  telegram: z.object({
    userId: z.number().int(),
    chatId: z.number().int(),
    statusMessageId: z.number().int(),
  }),
  media: z.object({
    sourceUrl: z.string().min(1),
    // Built from the shared vocabulary rather than repeated here: a hand-copied
    // literal list would accept the four platforms that existed when it was
    // written and silently reject every job for the fifth.
    platform: z.enum(MEDIA_PLATFORM_VALUES),
    type: z.enum(DOWNLOAD_TYPE_VALUES),
    quality: z.string().optional(),
    formatId: z.string().optional(),
    /**
     * What the chosen rendition was advertised to weigh, from the inspection
     * the user chose from. Carried so the worker can refuse an oversized job
     * BEFORE spending the bandwidth, rather than after.
     *
     * Optional because not every extractor reports a size, and a job enqueued
     * by an older release will not have one — neither is a reason to reject it.
     */
    estimatedBytes: z.number().int().nonnegative().optional(),
  }),
});

export function parseDownloadJobPayload(value: unknown): DownloadJobPayload {
  return downloadJobPayloadSchema.parse(value) as DownloadJobPayload;
}

export class BullMqDownloadQueue implements DownloadQueuePort {
  constructor(
    private readonly queue: Queue<DownloadJobPayload>,
    private readonly logger: Logger,
  ) {}

  async enqueue(payload: DownloadJobPayload): Promise<void> {
    // Using the job id as the BullMQ id makes the queue itself reject a
    // duplicate: a double tap that slips past the status check adds nothing.
    await this.queue.add(DOWNLOAD_JOB_NAME, payload, { jobId: payload.jobId });
  }

  async remove(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      // `remove()` throws on a job that is currently locked by a worker. That is
      // the running case, and it is handled elsewhere — the worker sees the
      // cancelled status and aborts — so failing to remove it is not an error.
      await job?.remove();
    } catch (error: unknown) {
      this.logger.debug('queued job could not be removed; it is probably already running', {
        jobId,
        error: describeError(error),
      });
    }
  }
}
