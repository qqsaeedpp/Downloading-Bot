import type {
  DownloadProgress,
  DownloadStage,
  DownloadType,
  MediaKind,
  MediaPlatform,
} from '@tgtools/shared';

/**
 * The engine's own vocabulary.
 *
 * It deliberately does NOT reuse the downloader feature's domain model: the
 * feature's `MediaInfo` is shaped by what a Telegram card needs to show, while
 * this is shaped by what an extractor actually reports. Keeping them apart is
 * what lets either change without dragging the other along — the mapping
 * between them lives in the feature's infrastructure layer, where it belongs.
 */

export interface EngineMediaFormat {
  readonly id: string;
  readonly ext: string;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly fps: number | undefined;
  /** `"none"` for an audio-only stream. Absent when the extractor did not say. */
  readonly videoCodec: string | undefined;
  /** `"none"` for a video-only stream. */
  readonly audioCodec: string | undefined;
  /** Declared size. Absent far more often than you would hope. */
  readonly filesizeBytes: number | undefined;
  /** Total bitrate in kbps — the only way to estimate a size when none is given. */
  readonly totalBitrateKbps: number | undefined;
  readonly audioBitrateKbps: number | undefined;
  readonly protocol: string | undefined;
  readonly formatNote: string | undefined;
  /** Carries both streams, so it needs no merge step. */
  readonly isProgressive: boolean;
  readonly isVideoOnly: boolean;
  readonly isAudioOnly: boolean;
}

export interface EngineMediaStatistics {
  readonly viewCount: number | undefined;
  readonly likeCount: number | undefined;
  readonly commentCount: number | undefined;
}

export interface EngineMediaInfo {
  readonly sourceUrl: string;
  readonly platform: MediaPlatform;
  readonly extractorId: string | undefined;
  readonly title: string;
  readonly uploader: string | undefined;
  readonly durationSeconds: number | undefined;
  readonly thumbnailUrl: string | undefined;
  /** ISO `YYYY-MM-DD`; yt-dlp reports `YYYYMMDD` and the mapper converts it. */
  readonly uploadDate: string | undefined;
  readonly description: string | undefined;
  readonly statistics: EngineMediaStatistics;
  readonly mediaKind: MediaKind;
  /** The result was obtained with operator cookies, so it must not be cached publicly. */
  readonly obtainedWithCookies: boolean;
  readonly formats: readonly EngineMediaFormat[];
}

export interface EngineInspectRequest {
  readonly url: string;
  readonly platform: MediaPlatform;
  /**
   * Netscape `cookies.txt` content. Normally left unset: the engine resolves
   * cookies itself through its {@link CookieProvider}, so a job payload never
   * has to carry one. Present only for tests and one-off overrides.
   */
  readonly cookies?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface EngineDownloadRequest {
  readonly url: string;
  readonly platform: MediaPlatform;
  readonly type: DownloadType;
  /** `"1080p"` for video, `"192k"` for audio. */
  readonly quality?: string | undefined;
  readonly formatId?: string | undefined;
}

export interface EngineDownloadContext {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: DownloadProgress) => void | Promise<void>) | undefined;
  readonly onStageChange?: ((stage: DownloadStage) => void | Promise<void>) | undefined;
}

export interface EngineVideoMetadata {
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly durationSeconds: number | undefined;
  readonly thumbnailPath: string | undefined;
}

export interface EngineDownloadedMedia {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly video: EngineVideoMetadata | undefined;
  /** Removes the whole job workspace. Idempotent; safe to call more than once. */
  cleanup(): Promise<void>;
}

/**
 * What the engine offers for a given piece of media, already filtered down to
 * options that can actually be delivered.
 */
export interface EngineQualityOption {
  readonly id: string;
  readonly type: DownloadType;
  /** Short label for a button, e.g. `1080p` or `192kbps`. */
  readonly label: string;
  readonly height: number | undefined;
  readonly audioBitrateKbps: number | undefined;
  readonly estimatedBytes: number | undefined;
  readonly formatId: string | undefined;
}

/** The contract the feature's adapter binds to. */
export interface MediaEngine {
  inspect(request: EngineInspectRequest): Promise<EngineMediaInfo>;
  listQualityOptions(info: EngineMediaInfo): readonly EngineQualityOption[];
  download(
    request: EngineDownloadRequest,
    context: EngineDownloadContext,
  ): Promise<EngineDownloadedMedia>;
  /** Tool versions, logged at startup so a bug report says which yt-dlp produced it. */
  probeToolchain(): Promise<ToolchainInfo>;
}

export interface ToolchainInfo {
  readonly ytDlpVersion: string | undefined;
  readonly ffmpegVersion: string | undefined;
  readonly ffprobeVersion: string | undefined;
}
