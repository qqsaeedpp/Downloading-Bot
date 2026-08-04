import type {
  DownloadAccessPolicy,
  DownloadCancellationBus,
  DownloadContext,
  DownloadFailureCode,
  DownloadJobPayload,
  DownloadMediaRequest,
  DownloadProgressReporter,
  DownloadQueuePort,
  DownloadedMedia,
  InspectMediaRequest,
  MediaDownloaderPort,
  MediaInfo,
  SendMediaCommand,
  SentMedia,
  TelegramMediaSenderPort,
} from '@tgtools/feature-downloader';
import { DownloadError } from '@tgtools/feature-downloader';
import type { DownloadProgress, DownloadStage, VideoDeliveryMode } from '@tgtools/shared';

export class FakeQueue implements DownloadQueuePort {
  readonly enqueued: DownloadJobPayload[] = [];
  readonly removed: string[] = [];

  enqueue(payload: DownloadJobPayload): Promise<void> {
    this.enqueued.push(payload);
    return Promise.resolve();
  }

  remove(jobId: string): Promise<void> {
    this.removed.push(jobId);
    return Promise.resolve();
  }

  /** The message a worker would receive next. */
  next(): DownloadJobPayload {
    const payload = this.enqueued[0];
    if (payload === undefined) throw new Error('queue is empty');
    return payload;
  }
}

export class FakeCancellationBus implements DownloadCancellationBus {
  readonly published: string[] = [];
  #handler: ((jobId: string) => void) | undefined;

  publishCancel(jobId: string): Promise<void> {
    this.published.push(jobId);
    this.#handler?.(jobId);
    return Promise.resolve();
  }

  subscribeCancel(handler: (jobId: string) => void): Promise<() => Promise<void>> {
    this.#handler = handler;
    return Promise.resolve(() => {
      this.#handler = undefined;
      return Promise.resolve();
    });
  }
}

export class FakeSender implements TelegramMediaSenderPort {
  readonly sent: SendMediaCommand[] = [];
  failWith: Error | undefined;

  send(command: SendMediaCommand): Promise<SentMedia> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.sent.push(command);
    return Promise.resolve({ fileId: `file-${String(this.sent.length)}`, messageId: 500 });
  }
}

export class RecordingReporter implements DownloadProgressReporter {
  readonly stages: DownloadStage[] = [];
  readonly progress: DownloadProgress[] = [];
  readonly failures: DownloadFailureCode[] = [];
  completed = false;

  onStage(stage: DownloadStage): Promise<void> {
    this.stages.push(stage);
    return Promise.resolve();
  }

  onProgress(progress: DownloadProgress): Promise<void> {
    this.progress.push(progress);
    return Promise.resolve();
  }

  onCompleted(): Promise<void> {
    this.completed = true;
    return Promise.resolve();
  }

  onFailed(code: DownloadFailureCode): Promise<void> {
    this.failures.push(code);
    return Promise.resolve();
  }
}

export class AllowAllAccessPolicy implements DownloadAccessPolicy {
  inspectAllowed = true;
  downloadAllowed = true;
  limit = 2;

  canInspect(): Promise<boolean> {
    return Promise.resolve(this.inspectAllowed);
  }

  canCreateDownload(): Promise<boolean> {
    return Promise.resolve(this.downloadAllowed);
  }

  getActiveJobLimit(): Promise<number> {
    return Promise.resolve(this.limit);
  }
}

export interface ScriptedMedia {
  readonly fileSize?: number;
  readonly mimeType?: string;
  readonly fileName?: string;
  /** Lets a test drive the sender down the document branch without ffprobe. */
  readonly deliveryMode?: VideoDeliveryMode;
  readonly transcodeSkippedReason?: string | undefined;
}

/**
 * A downloader that produces whatever the test asks for, without a process, a
 * network or a disk. `cleanedUp` is the assertion that matters most: a job must
 * remove its workspace on every path, including the ones that failed.
 */
export class ScriptedDownloader implements MediaDownloaderPort {
  inspectResult: MediaInfo | Error | undefined;
  downloadResult: ScriptedMedia | Error | undefined;
  /** Progress samples handed to the caller before the download resolves. */
  progressSamples: DownloadProgress[] = [];
  cleanedUp = 0;
  readonly downloadRequests: DownloadMediaRequest[] = [];
  readonly inspectRequests: InspectMediaRequest[] = [];
  /** Set to have the download hang until the context signal aborts. */
  waitForAbort = false;

  supports(): boolean {
    return true;
  }

  inspect(request: InspectMediaRequest): Promise<MediaInfo> {
    this.inspectRequests.push(request);
    if (this.inspectResult instanceof Error) return Promise.reject(this.inspectResult);
    if (this.inspectResult === undefined) {
      return Promise.reject(new Error('ScriptedDownloader.inspectResult was not set'));
    }
    return Promise.resolve(this.inspectResult);
  }

  async download(
    request: DownloadMediaRequest,
    context: DownloadContext,
  ): Promise<DownloadedMedia> {
    this.downloadRequests.push(request);

    for (const sample of this.progressSamples) await context.onProgress?.(sample);

    if (this.waitForAbort) {
      await new Promise<void>((_, reject) => {
        const signal = context.signal;
        if (signal === undefined) return;
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          },
          { once: true },
        );
      });
    }

    if (this.downloadResult instanceof Error) throw this.downloadResult;
    if (this.downloadResult === undefined) {
      throw new Error('ScriptedDownloader.downloadResult was not set');
    }

    const scripted = this.downloadResult;
    return {
      filePath: '/tmp/job-test/media.mp4',
      fileName: scripted.fileName ?? 'media.mp4',
      mimeType: scripted.mimeType ?? 'video/mp4',
      fileSize: scripted.fileSize ?? 1_024,
      video: {
        width: 720,
        height: 1280,
        duration: 27,
        thumbnailPath: undefined,
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'mp4',
      },
      // The default fake is the ordinary case: already playable, sent as a
      // video, nothing skipped.
      deliveryMode: scripted.deliveryMode ?? 'direct-video',
      transcodeSkippedReason: scripted.transcodeSkippedReason,
      cleanup: () => {
        this.cleanedUp += 1;
        return Promise.resolve();
      },
    };
  }
}

export function downloadError(
  code: DownloadFailureCode,
  message = 'scripted failure',
): DownloadError {
  return new DownloadError(code, message);
}
