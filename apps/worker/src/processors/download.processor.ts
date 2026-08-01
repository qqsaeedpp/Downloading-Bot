import { TelegramProgressReporter, parseDownloadJobPayload } from '@tgtools/feature-downloader';
import { describeError } from '@tgtools/shared';
import type { Job } from 'bullmq';
import type { WorkerContainer } from '../container.js';

/**
 * Adapts one BullMQ delivery into one use-case call.
 *
 * Everything the processor does is translation: parse the message, build the
 * reporter that will write into the user's chat, register the abort controller
 * so a cancellation can reach the running process, and release it afterwards.
 * The actual pipeline lives in the use case, where it can be tested without a
 * queue.
 */
export function createDownloadProcessor(container: WorkerContainer) {
  return async (job: Job<unknown>): Promise<void> => {
    const logger = container.logger.child({ bullJobId: job.id, attempt: job.attemptsMade + 1 });

    let payload;
    try {
      payload = parseDownloadJobPayload(job.data);
    } catch (error: unknown) {
      // A message this worker cannot understand will never become
      // understandable, so retrying it would only occupy a slot until the
      // attempt budget runs out.
      logger.error('discarding an unparsable job payload', { error: describeError(error) });
      return;
    }

    const controller = container.running.register(payload.jobId);
    const reporter = new TelegramProgressReporter({
      api: container.telegramApi,
      chatId: payload.telegram.chatId,
      messageId: payload.telegram.statusMessageId,
      // The short id is what the cancel button carries; deriving it from the
      // job id would produce a button that decodes to nothing.
      shortId: await resolveShortId(container, payload.jobId),
      logger,
    });

    try {
      const outcome = await container.downloader.processDownload.execute({
        payload,
        reporter,
        signal: controller.signal,
      });
      logger.debug('job finished', { outcome });
    } finally {
      container.running.release(payload.jobId);
    }
  };
}

/**
 * The payload carries the internal job id; the keyboard needs the short one.
 * Looking it up costs one indexed read per job, which is cheaper than widening
 * the payload and having to migrate every message already sitting in Redis.
 */
async function resolveShortId(container: WorkerContainer, jobId: string): Promise<string> {
  const job = await container.downloader.getStatus.byId(jobId);
  return job?.shortId ?? '';
}
