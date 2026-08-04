import type {
  DownloadProgress,
  DownloadStage,
  DownloadType,
  MediaPlatform,
  VideoDeliveryMode,
} from '@tgtools/shared';
import type { MediaInfo } from '../entities/media-info.js';

export interface InspectMediaRequest {
  readonly url: string;
  readonly platform: MediaPlatform;
  /**
   * Present only for tests and manual overrides. In production the adapter
   * leaves this unset and the engine resolves cookies itself, so a session
   * never travels through a use case, a queue payload or a database row.
   */
  readonly cookies?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface DownloadMediaRequest {
  readonly url: string;
  readonly platform: MediaPlatform;
  readonly type: DownloadType;
  readonly quality?: string | undefined;
  readonly formatId?: string | undefined;
  /**
   * What the chosen rendition was advertised to weigh, when the extractor said.
   *
   * Lets the engine decline before transferring anything. Advisory only — an
   * absent or wrong estimate must never be the reason a legitimate download is
   * refused, so the real size is checked again after the transfer.
   */
  readonly estimatedBytes?: number | undefined;
}

export interface DownloadContext {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: DownloadProgress) => Promise<void> | void) | undefined;
  readonly onStageChange?: ((stage: DownloadStage) => Promise<void> | void) | undefined;
}

export interface DownloadedMediaVideo {
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly duration: number | undefined;
  readonly thumbnailPath: string | undefined;
  /**
   * What ffprobe found in the file being handed over. Carried rather than
   * re-derived downstream because an `.mp4` extension says nothing about
   * whether Telegram can stream what is inside it.
   */
  readonly videoCodec: string | undefined;
  readonly audioCodec: string | undefined;
  readonly container: string | undefined;
}

export interface DownloadedMedia {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly video: DownloadedMediaVideo | undefined;
  /** How this file is meant to reach the user; decided from ffprobe's verdict. */
  readonly deliveryMode: VideoDeliveryMode;
  /** Why a re-encode was declined, when one was. For the delivery log. */
  readonly transcodeSkippedReason: string | undefined;
  /** Removes the job's workspace. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * The feature's view of "something that can fetch media".
 *
 * Everything the domain and the use cases know about yt-dlp is this interface.
 * Swapping the engine, or standing up a fake for a test, is a matter of
 * providing another implementation — no use case changes.
 */
export interface MediaDownloaderPort {
  supports(url: URL): boolean;
  inspect(request: InspectMediaRequest): Promise<MediaInfo>;
  download(request: DownloadMediaRequest, context: DownloadContext): Promise<DownloadedMedia>;
}
