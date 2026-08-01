export type {
  EngineDownloadContext,
  EngineDownloadRequest,
  EngineDownloadedMedia,
  EngineInspectRequest,
  EngineMediaFormat,
  EngineMediaInfo,
  EngineMediaStatistics,
  EngineQualityOption,
  EngineVideoMetadata,
  MediaEngine,
  ToolchainInfo,
} from './engine-types.js';

export { EngineError, EngineFailureCode, isEngineError } from './errors/engine-error.js';
export type { EngineErrorOptions } from './errors/engine-error.js';
export { YtDlpErrorMapper } from './errors/ytdlp-error-mapper.js';
export type { YtDlpFailure } from './errors/ytdlp-error-mapper.js';
export {
  STALE_SESSION_PATTERNS,
  YTDLP_ERROR_PATTERNS,
  matchesStaleSession,
} from './errors/ytdlp-error-patterns.js';

export { createDownloaderEngine } from './create-engine.js';
export type {
  CreateEngineOptions,
  EngineBinaries,
  EngineBundle,
  EngineFfmpegSettings,
  EngineLimits,
} from './create-engine.js';

export { DEFAULT_PLATFORM_DEFINITIONS, createPlatformRegistry } from './platforms/registry.js';
export type { PlatformRegistry } from './platforms/registry.js';
export {
  COMMON_TRACKING_PARAMS,
  defineHostPatterns,
  matchesAnyPattern,
} from './platforms/platform-definition.js';
export type {
  PlatformDefinition,
  PlatformDownloadPolicy,
} from './platforms/platform-definition.js';
export { instagramPlatform } from './platforms/instagram.js';
export { tiktokPlatform } from './platforms/tiktok.js';
export { pinterestPlatform } from './platforms/pinterest.js';
export { xPlatform } from './platforms/x.js';
export { extractYouTubeVideoId, youtubePlatform } from './platforms/youtube.js';

export { UrlGuard, normalizeUrl } from './security/url-guard.js';
export type { SafeMediaUrl } from './security/url-guard.js';
export { inspectIpAddress, isPublicIpAddress } from './security/ip-rules.js';
export type { AddressVerdict } from './security/ip-rules.js';
export { RedirectResolver, assertResolvesToPublicAddress } from './security/redirect-resolver.js';
export type { RedirectResolverOptions } from './security/redirect-resolver.js';
export { extractUrls, trimTrailingPunctuation } from './security/url-extractor.js';
export type { ExtractedUrls } from './security/url-extractor.js';

export { createWorkspaceFactory } from './workspace/job-workspace.js';
export type { JobWorkspace, WorkspaceFactory } from './workspace/job-workspace.js';
export { startSizeWatchdog } from './workspace/size-watchdog.js';
export type { SizeWatchdog } from './workspace/size-watchdog.js';

export { NoCookieProvider } from './cookies/cookie-provider.js';
export type { CookieProvider } from './cookies/cookie-provider.js';
export { FileCookieProvider, looksLikeNetscapeCookieJar } from './cookies/file-cookie-provider.js';
export { withCookieFile } from './cookies/cookie-file.js';

export {
  YtDlpFormatSelector,
  hasExtractableAudio,
  parseRequestedBitrate,
  parseRequestedHeight,
} from './ytdlp/format-selector.js';
export type { AudioSelectorInput, VideoSelectorInput } from './ytdlp/format-selector.js';
export { YtDlpInfoMapper, classifyMediaKind, toIsoDate } from './ytdlp/info-mapper.js';
export {
  buildAudioDownloadArgs,
  buildBaseArgs,
  buildImageDownloadArgs,
  buildInspectArgs,
  buildVideoDownloadArgs,
} from './ytdlp/args-builder.js';
export { withStaleCookieRetry } from './ytdlp/stale-cookie-retry.js';
export { YtDlpMediaEngine } from './ytdlp/ytdlp-media-engine.js';
export { YtDlpNodeRunner } from './ytdlp/ytdlp-node-runner.js';
export { YtDlpProcessError } from './ytdlp/ytdlp-runner.port.js';
export type {
  YtDlpDownloadInvocation,
  YtDlpInvocation,
  YtDlpResult,
  YtDlpRunner,
} from './ytdlp/ytdlp-runner.port.js';

export { Ffprobe, parseFfprobeOutput } from './media/ffprobe.js';
export type { ProbedMedia } from './media/ffprobe.js';
export { PlaybackNormalizer, planNormalization } from './media/playback-normalizer.js';
export type { NormalizationPlan, NormalizationResult } from './media/playback-normalizer.js';
export { ThumbnailGenerator, pickSeekPoint } from './media/thumbnail.js';
export { ImageNormalizer } from './media/image-normalizer.js';
export {
  isAudioMimeType,
  isImageMimeType,
  isVideoMimeType,
  mimeTypeForPath,
} from './media/mime.js';

export { ProcessFailedError, runProcess } from './process/run-process.js';
