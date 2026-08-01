import type {
  EngineDownloadedMedia,
  EngineMediaInfo,
  EngineQualityOption,
  MediaEngine,
} from '@tgtools/downloader-engine';
import { EngineError, EngineFailureCode } from '@tgtools/downloader-engine';
import type { MediaFormat, MediaInfo } from '../../domain/entities/media-info.js';
import { DownloadError } from '../../domain/errors/download-error.js';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import type {
  DownloadContext,
  DownloadMediaRequest,
  DownloadedMedia,
  InspectMediaRequest,
  MediaDownloaderPort,
} from '../../domain/ports/media-downloader.port.js';
import type { DownloadOption } from '../../domain/value-objects/download-option.js';

/**
 * The seam between the feature and the engine.
 *
 * Two vocabularies meet here — the engine's, shaped by what an extractor
 * reports, and the domain's, shaped by what a user is shown — and this is the
 * only file that speaks both. That costs a mapper, and buys the property that
 * neither side can drag the other along when it changes.
 */
export class EngineMediaDownloader implements MediaDownloaderPort {
  constructor(
    private readonly engine: MediaEngine,
    private readonly supportsUrl: (url: URL) => boolean,
  ) {}

  supports(url: URL): boolean {
    return this.supportsUrl(url);
  }

  async inspect(request: InspectMediaRequest): Promise<MediaInfo> {
    try {
      const info = await this.engine.inspect({
        url: request.url,
        platform: request.platform,
        cookies: request.cookies,
        signal: request.signal,
      });
      return toMediaInfo(info, this.engine.listQualityOptions(info));
    } catch (error: unknown) {
      throw toDomainError(error);
    }
  }

  async download(
    request: DownloadMediaRequest,
    context: DownloadContext,
  ): Promise<DownloadedMedia> {
    try {
      const media = await this.engine.download(
        {
          url: request.url,
          platform: request.platform,
          type: request.type,
          quality: request.quality,
          formatId: request.formatId,
        },
        {
          signal: context.signal,
          ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
          ...(context.onStageChange === undefined ? {} : { onStageChange: context.onStageChange }),
        },
      );
      return toDownloadedMedia(media);
    } catch (error: unknown) {
      throw toDomainError(error);
    }
  }
}

export function toMediaInfo(
  info: EngineMediaInfo,
  options: readonly EngineQualityOption[],
): MediaInfo {
  return {
    sourceUrl: info.sourceUrl,
    platform: info.platform,
    title: info.title,
    uploader: info.uploader,
    durationSeconds: info.durationSeconds,
    thumbnailUrl: info.thumbnailUrl,
    uploadDate: info.uploadDate,
    description: info.description,
    statistics: {
      viewCount: info.statistics.viewCount,
      likeCount: info.statistics.likeCount,
      commentCount: info.statistics.commentCount,
    },
    mediaKind: info.mediaKind,
    requiredAuthentication: info.obtainedWithCookies,
    formats: info.formats.map(toMediaFormat),
    availableOptions: options.map(toDownloadOption),
  };
}

function toMediaFormat(format: EngineMediaInfo['formats'][number]): MediaFormat {
  return {
    id: format.id,
    ext: format.ext,
    height: format.height,
    width: format.width,
    videoCodec: format.videoCodec,
    audioCodec: format.audioCodec,
    filesizeBytes: format.filesizeBytes,
  };
}

function toDownloadOption(option: EngineQualityOption): DownloadOption {
  return {
    id: option.id,
    type: option.type,
    label: option.label,
    height: option.height,
    audioBitrateKbps: option.audioBitrateKbps,
    estimatedBytes: option.estimatedBytes,
    formatId: option.formatId,
  };
}

function toDownloadedMedia(media: EngineDownloadedMedia): DownloadedMedia {
  return {
    filePath: media.filePath,
    fileName: media.fileName,
    mimeType: media.mimeType,
    fileSize: media.fileSize,
    video:
      media.video === undefined
        ? undefined
        : {
            width: media.video.width,
            height: media.video.height,
            duration: media.video.durationSeconds,
            thumbnailPath: media.video.thumbnailPath,
          },
    cleanup: () => media.cleanup(),
  };
}

/**
 * Engine code to domain code.
 *
 * Written out in full rather than passed through, because the two sets are not
 * the same: the engine distinguishes a geo-block from an unsupported format,
 * and the product does not — both mean "we cannot get this for you".
 */
const CODE_MAP: Readonly<Record<EngineFailureCode, DownloadFailureCode>> = {
  [EngineFailureCode.InvalidUrl]: DownloadFailureCode.InvalidUrl,
  [EngineFailureCode.UnsupportedPlatform]: DownloadFailureCode.UnsupportedPlatform,
  [EngineFailureCode.UnsupportedMedia]: DownloadFailureCode.UnsupportedMedia,
  [EngineFailureCode.PrivateMedia]: DownloadFailureCode.PrivateMedia,
  [EngineFailureCode.LoginRequired]: DownloadFailureCode.LoginRequired,
  [EngineFailureCode.PlatformBlocked]: DownloadFailureCode.PlatformBlocked,
  [EngineFailureCode.MediaNotFound]: DownloadFailureCode.MediaNotFound,
  [EngineFailureCode.FormatUnavailable]: DownloadFailureCode.FormatUnavailable,
  [EngineFailureCode.MediaTooLarge]: DownloadFailureCode.MediaTooLarge,
  [EngineFailureCode.GeoRestricted]: DownloadFailureCode.UnsupportedMedia,
  [EngineFailureCode.RateLimited]: DownloadFailureCode.RateLimited,
  [EngineFailureCode.DownloadTimeout]: DownloadFailureCode.DownloadTimeout,
  [EngineFailureCode.ProcessingTimeout]: DownloadFailureCode.ProcessingTimeout,
  [EngineFailureCode.DownloadFailed]: DownloadFailureCode.DownloadFailed,
  [EngineFailureCode.ProcessingFailed]: DownloadFailureCode.ProcessingFailed,
  [EngineFailureCode.Cancelled]: DownloadFailureCode.JobCancelled,
  [EngineFailureCode.ToolchainMissing]: DownloadFailureCode.InternalError,
  [EngineFailureCode.InsufficientStorage]: DownloadFailureCode.InternalError,
  [EngineFailureCode.Internal]: DownloadFailureCode.InternalError,
};

export function toDomainError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  if (error instanceof EngineError) {
    return new DownloadError(CODE_MAP[error.code], error.message, {
      cause: error,
      retryable: error.retryable,
    });
  }
  return DownloadError.internal(error instanceof Error ? error.message : String(error), error);
}
