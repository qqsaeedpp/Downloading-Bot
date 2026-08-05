import { ToolError, ToolErrorCode } from '@tgtools/file-tools-engine';
import { classifyToolFailure, faTools, outputFileName } from '@tgtools/feature-tools';
import { ToolJobStatus, describeError, isTerminalToolJobStatus } from '@tgtools/shared';
import { editStatusMessage } from '@tgtools/telegram';
import { parseToolJobPayload } from '@tgtools/tool-contracts';
import type { ToolJobPayload } from '@tgtools/tool-contracts';
import type { Job } from 'bullmq';
import type { ToolsWorkerContainer } from '../container.js';
import type { FetchedFile } from '../telegram/tool-file-fetcher.js';
import { expectedInputKind, runTool } from './tool-runner.js';
import type { ToolRunSummary } from './tool-runner.js';

/**
 * One BullMQ delivery, from queue message to delivered file.
 *
 * The ordering here is not arbitrary. Every step that can fail happens before
 * the one that costs money: the payload is parsed before a row is read, the row
 * is checked for cancellation before a file is fetched, the file is fetched
 * before ffmpeg starts, and the size is checked before the upload begins.
 */
export function createToolProcessor(container: ToolsWorkerContainer) {
  return async (job: Job<unknown>): Promise<void> => {
    const attempt = job.attemptsMade + 1;
    const logger = container.logger.child({ bullJobId: job.id, attempt });

    const parsed = parseToolJobPayload(job.data);
    if (!parsed.ok) {
      // A message this build cannot understand will never become
      // understandable, so retrying it only occupies a queue slot until the
      // attempt budget runs out. Thrown away deliberately, and loudly.
      logger.error('discarding an unparsable tool job', { reason: parsed.reason });
      return;
    }

    const payload = parsed.payload;
    await runOne(container, payload, attempt, logger);
  };
}

async function runOne(
  container: ToolsWorkerContainer,
  payload: ToolJobPayload,
  attempt: number,
  logger: ReturnType<ToolsWorkerContainer['logger']['child']>,
): Promise<void> {
  const record = await container.toolJobs.findById(payload.jobId);
  if (record === undefined) {
    logger.error('tool job has no row; refusing to run it', { jobId: payload.jobId });
    return;
  }

  // A cancel tap that landed while the job sat in the queue. Running it anyway
  // would send the user a file they explicitly said they did not want.
  if (isTerminalToolJobStatus(record.status)) {
    logger.info('skipping a job that already reached a terminal state', {
      jobId: payload.jobId,
      status: record.status,
    });
    return;
  }

  const controller = container.running.register(payload.jobId);
  const signal = controller.signal;
  let version = record.version;

  const setStatus = async (status: ToolJobStatus, extra?: StatusExtras): Promise<void> => {
    const applied = await container.toolJobs.updateStatus({
      jobId: payload.jobId,
      status,
      expectedVersion: version,
      ...(extra ?? {}),
    });
    // A losing write means another actor moved the job — a cancel, or a
    // duplicate delivery. Re-read rather than carrying on with a stale version,
    // which would make every following write fail too.
    version = applied
      ? version + 1
      : ((await container.toolJobs.findById(payload.jobId))?.version ?? version);
  };

  const say = async (text: string): Promise<void> => {
    await editStatusMessage({
      api: container.telegramApi,
      chatId: payload.telegram.chatId,
      messageId: payload.telegram.statusMessageId,
      text,
      logger,
    });
  };

  try {
    await container.workspaces.assertDiskSpace();

    const outputs = await container.workspaces.with(payload.jobId, async (workspace) => {
      const expect = expectedInputKind(payload.tool);
      const inputs: FetchedFile[] = [];

      if (expect !== undefined) {
        await setStatus(ToolJobStatus.Receiving);
        await say(faTools.status(ToolJobStatus.Receiving));

        for (const reference of payload.inputs) {
          inputs.push(
            await container.fetcher.fetch({
              reference,
              workspace,
              expect,
              maxBytes: ceilingFor(container, payload.tool),
              signal,
            }),
          );
        }
      }

      await setStatus(ToolJobStatus.Processing);
      await say(faTools.status(ToolJobStatus.Processing));

      const result = await runTool({
        operation: payload.operation,
        inputs,
        workspace,
        processors: container.processors,
        signal,
        videoTimeoutMs: container.config.tools.video.timeoutMs,
        // Progress is written to the row only. Editing the chat on every
        // ffmpeg tick would spend the whole rate-limit budget on a message
        // nobody is reading closely.
        onProgress: (fraction) => {
          void container.toolJobs
            .updateProgress(payload.jobId, Math.round(fraction * 100))
            .catch(() => undefined);
        },
      });

      await setStatus(ToolJobStatus.Uploading);
      await say(faTools.status(ToolJobStatus.Uploading));

      const sent = [];
      for (const [index, output] of result.outputs.entries()) {
        sent.push(
          await container.sender.send({
            chatId: payload.telegram.chatId,
            tool: payload.tool,
            path: output.path,
            fileName: outputFileName({
              tool: payload.tool,
              extension: output.extension,
              sourceName: inputs[0]?.originalName,
              ...(output.pageNumber === undefined ? {} : { pageNumber: output.pageNumber }),
              ...(output.pageCount === undefined ? {} : { pageCount: output.pageCount }),
            }),
            // One caption, on the first file only. Repeating it under all
            // fifty pages of a rendered PDF would be noise.
            caption: index === 0 ? captionFor(payload, result.summary) : undefined,
            signal,
            ...(output.durationSeconds === undefined
              ? {}
              : { durationSeconds: output.durationSeconds }),
          }),
        );
      }
      return sent;
    });

    const first = outputs[0];
    await container.toolJobs.complete({
      jobId: payload.jobId,
      expectedVersion: version,
      outputFileId: first?.fileId,
      outputFileUniqueId: first?.fileUniqueId,
      outputMimeType: undefined,
      outputFileName: undefined,
      outputSize: outputs.reduce((total, output) => total + output.sizeBytes, 0),
    });

    await container.events
      .record(payload.jobId, 'completed', { files: outputs.length, attempt })
      .catch(() => undefined);
    logger.info('tool job finished', { jobId: payload.jobId, tool: payload.tool });
  } catch (error: unknown) {
    await handleFailure(container, payload, attempt, error, logger, setStatus, say);
    // Re-thrown ONLY when another attempt is genuinely wanted; see below.
    if (shouldRethrow(error, attempt, container)) throw error;
  } finally {
    container.running.release(payload.jobId);
  }
}

interface StatusExtras {
  readonly errorCode?: string | undefined;
  readonly errorMessageSafe?: string | undefined;
  readonly incrementAttempt?: boolean | undefined;
}

async function handleFailure(
  container: ToolsWorkerContainer,
  payload: ToolJobPayload,
  attempt: number,
  error: unknown,
  logger: ReturnType<ToolsWorkerContainer['logger']['child']>,
  setStatus: (status: ToolJobStatus, extra?: StatusExtras) => Promise<void>,
  say: (text: string) => Promise<void>,
): Promise<void> {
  const failure = classifyToolFailure(error);
  const willRetry = shouldRethrow(error, attempt, container);

  logger.error('tool job failed', {
    jobId: payload.jobId,
    tool: payload.tool,
    code: failure.code,
    retryable: failure.retryable,
    willRetry,
    error: failure.logMessage,
  });

  await container.events
    .record(payload.jobId, willRetry ? 'attempt-failed' : 'failed', {
      code: failure.code,
      attempt,
    })
    .catch(() => undefined);

  if (willRetry) {
    // Back to `queued`, NOT `failed`. BullMQ has already scheduled the next
    // attempt, and a terminal row would leave that attempt unable to make any
    // legal move — the job would be retried and never able to report how it
    // went. The user keeps seeing "in the queue", which is true.
    await setStatus(ToolJobStatus.Queued, { incrementAttempt: true }).catch(
      (writeError: unknown) => {
        logger.error('could not return the job to the queue', { error: describeError(writeError) });
      },
    );
    return;
  }

  await setStatus(ToolJobStatus.Failed, {
    errorCode: failure.code,
    errorMessageSafe: failure.storedMessage,
    incrementAttempt: true,
  }).catch((writeError: unknown) => {
    logger.error('could not record the failure', { error: describeError(writeError) });
  });

  // The user has been staring at "processing" this whole time. Telling them is
  // the last thing that happens, and it happens even when the row write failed.
  await say(faTools.failure(failure.code));
}

/**
 * Whether to let BullMQ try again.
 *
 * Rethrowing is what schedules a retry, so this has to agree exactly with what
 * `handleFailure` wrote: rethrowing after writing `failed` produces the stranded
 * job described above, and swallowing after writing `queued` produces a job that
 * says "queued" forever with nothing left to run it.
 */
function shouldRethrow(error: unknown, attempt: number, container: ToolsWorkerContainer): boolean {
  const failure = classifyToolFailure(error);
  if (!failure.retryable) return false;
  return attempt < container.config.tools.queue.attempts;
}

function ceilingFor(container: ToolsWorkerContainer, tool: ToolJobPayload['tool']): number {
  const tools = container.config.tools;
  if (tool.startsWith('video.')) return tools.video.maxInputBytes;
  if (tool === 'pdf.to_images') return tools.pdf.maxInputBytes;
  // `pdf.images_to_pdf` consumes IMAGES, so it is bounded by the image ceiling
  // even though it is queued and priced as PDF work.
  return tools.image.maxInputBytes;
}

/** Renders the run's structured facts; the runner never returns Persian itself. */
function captionFor(payload: ToolJobPayload, summary: ToolRunSummary | undefined): string {
  if (summary === undefined) return faTools.completed(payload.tool, 0).split('\n')[0] ?? '';
  switch (summary.kind) {
    case 'compressed':
      return faTools.compressionSummary(summary.originalBytes, summary.finalBytes);
    case 'kept-original':
      return faTools.keptOriginal();
    case 'target-missed':
      return faTools.targetMissed(summary.targetBytes);
    case 'pages':
      return faTools.pagesRendered(summary.count);
  }
}

/** Re-exported for the workers, which have to know what they are consuming. */
export { ToolError, ToolErrorCode };
