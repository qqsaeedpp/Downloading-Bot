import type { DownloadProgress, DownloadStage, DownloadType, MediaPlatform } from '@tgtools/shared';
import type { MediaInfo } from '../entities/media-info.js';
import type { DownloadFailureCode } from '../errors/download-failure-code.js';

/**
 * Append-only history. Kept behind a port so the use cases can record what
 * happened without knowing whether it lands in Postgres, a log, or nothing at
 * all during a test.
 */
export interface DownloadEventRepository {
  record(input: {
    readonly jobId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

export interface MediaInspectionCacheKey {
  readonly normalizedUrlHash: string;
  /**
   * Part of the key, not a field on the value.
   *
   * A result obtained with operator cookies can reveal a post that an anonymous
   * visitor is not entitled to see. Serving it from a shared cache to an
   * anonymous lookup would leak exactly that, so the two are cached separately.
   */
  readonly requiredAuth: boolean;
}

export interface MediaInspectionCache {
  get(key: MediaInspectionCacheKey): Promise<MediaInfo | undefined>;
  set(key: MediaInspectionCacheKey, value: MediaInfo, ttlSeconds: number): Promise<void>;
  invalidate(key: MediaInspectionCacheKey): Promise<void>;
}

/**
 * What the bot hands to the worker. Small, and free of secrets: it is stored in
 * Redis, where it outlives the request and is visible to anything that can read
 * the queue.
 */
export interface DownloadJobPayload {
  readonly jobId: string;
  readonly requestId: string;
  readonly telegram: {
    readonly userId: number;
    readonly chatId: number;
    readonly statusMessageId: number;
  };
  readonly media: {
    readonly sourceUrl: string;
    readonly platform: MediaPlatform;
    readonly type: DownloadType;
    readonly quality: string | undefined;
    readonly formatId: string | undefined;
  };
}

export interface DownloadQueuePort {
  /**
   * `jobId` doubles as the BullMQ job id, so a double tap that slips past the
   * status check is de-duplicated by the queue itself rather than downloading
   * the same file twice.
   */
  enqueue(payload: DownloadJobPayload): Promise<void>;
  /** Best-effort: a job already in flight is stopped by the abort registry. */
  remove(jobId: string): Promise<void>;
}

/**
 * Cancellation crosses a process boundary: the tap lands in the bot, the
 * running yt-dlp lives in a worker. Marking the row alone is not enough — the
 * worker would keep pulling bytes until its own timeout — so the intent has to
 * be broadcast to whichever worker holds the job.
 */
export interface DownloadCancellationBus {
  publishCancel(jobId: string): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribeCancel(handler: (jobId: string) => void): Promise<() => Promise<void>>;
}

export interface SentMedia {
  readonly fileId: string | undefined;
  readonly messageId: number;
}

export interface SendMediaCommand {
  readonly chatId: number;
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly caption: string;
  readonly type: DownloadType;
  readonly video:
    | {
        readonly width: number | undefined;
        readonly height: number | undefined;
        readonly duration: number | undefined;
        readonly thumbnailPath: string | undefined;
      }
    | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface TelegramMediaSenderPort {
  send(command: SendMediaCommand): Promise<SentMedia>;
}

/**
 * Progress belongs to presentation, but the worker's use case is what knows
 * when it changes. This port is how the two meet without the use case importing
 * grammY.
 */
export interface DownloadProgressReporter {
  onStage(stage: DownloadStage): Promise<void>;
  onProgress(progress: DownloadProgress): Promise<void>;
  onCompleted(summary: { readonly fileSize: number; readonly fileName: string }): Promise<void>;
  onFailed(code: DownloadFailureCode): Promise<void>;
}

/**
 * Who may do what.
 *
 * Isolated from the outset so that a plan, a subscription or an allow-list can
 * be added later by replacing the implementation — the use cases already ask
 * the question, they just get a simple answer today.
 */
export interface DownloadAccessPolicy {
  canInspect(userId: string): Promise<boolean>;
  canCreateDownload(userId: string): Promise<boolean>;
  getActiveJobLimit(userId: string): Promise<number>;
}
