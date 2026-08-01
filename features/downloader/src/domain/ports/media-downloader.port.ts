import type { DownloadProgress, DownloadStage, DownloadType, MediaPlatform } from '@tgtools/shared';
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
}

export interface DownloadedMedia {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly video: DownloadedMediaVideo | undefined;
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
