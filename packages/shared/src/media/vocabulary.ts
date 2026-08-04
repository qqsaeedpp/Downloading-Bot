/**
 * The shared kernel: the handful of names the downloader domain, the engine and
 * the transport all have to agree on. Deliberately a *closed* set — nothing gets
 * added here unless at least two layers genuinely need the same word, otherwise
 * this file becomes the dumping ground the architecture rules forbid.
 *
 * These are plain data with no behaviour and no dependencies, so a domain module
 * importing them stays framework-free.
 */

/**
 * The single source of truth for the platform slugs.
 *
 * Declared as a non-empty tuple so that a Zod schema can be built straight from
 * it — `z.enum(MEDIA_PLATFORM_VALUES)` — instead of repeating the literals. Two
 * such copies previously existed in the queue payload schema and the cache
 * schema, and adding a platform without updating them would have silently
 * discarded every job for it.
 */
export const MEDIA_PLATFORM_VALUES = ['instagram', 'tiktok', 'pinterest', 'x', 'youtube'] as const;

export const MediaPlatform = {
  Instagram: 'instagram',
  TikTok: 'tiktok',
  Pinterest: 'pinterest',
  X: 'x',
  YouTube: 'youtube',
} as const;
export type MediaPlatform = (typeof MediaPlatform)[keyof typeof MediaPlatform];

export const ALL_MEDIA_PLATFORMS: readonly MediaPlatform[] = MEDIA_PLATFORM_VALUES;

export function isMediaPlatform(value: string): value is MediaPlatform {
  return (ALL_MEDIA_PLATFORMS as readonly string[]).includes(value);
}

/** What the user asked us to produce. */
export const DOWNLOAD_TYPE_VALUES = ['video', 'audio', 'image'] as const;

export const DownloadType = {
  Video: 'video',
  Audio: 'audio',
  Image: 'image',
} as const;
export type DownloadType = (typeof DownloadType)[keyof typeof DownloadType];

export const ALL_DOWNLOAD_TYPES: readonly DownloadType[] = DOWNLOAD_TYPE_VALUES;

export function isDownloadType(value: string): value is DownloadType {
  return (ALL_DOWNLOAD_TYPES as readonly string[]).includes(value);
}

/** What the source actually is, as far as the extractor could tell. */
export const MEDIA_KIND_VALUES = ['video', 'image', 'audio', 'unknown'] as const;

export const MediaKind = {
  Video: 'video',
  Image: 'image',
  Audio: 'audio',
  Unknown: 'unknown',
} as const;
export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];

/**
 * Coarse phases of a job, in the order they occur. Used for user-visible status
 * text, so the granularity is "what would a person want to read", not "what step
 * is the code on".
 */
export const DownloadStage = {
  Preparing: 'preparing',
  Downloading: 'downloading',
  /**
   * Repackaging only — a stream copy, no decoding. Seconds, not minutes.
   *
   * Separate from {@link DownloadStage.Normalizing} because the two feel nothing
   * alike to the person waiting, and calling a two-second remux an
   * "optimisation" invites them to expect the multi-minute kind.
   */
  Packaging: 'packaging',
  /** A real re-encode. The only stage here that can take minutes. */
  Normalizing: 'normalizing',
  Uploading: 'uploading',
} as const;
export type DownloadStage = (typeof DownloadStage)[keyof typeof DownloadStage];

/**
 * How a finished file is meant to reach the user.
 *
 * Lives here rather than in the engine because three layers need to agree on it:
 * the engine decides it from ffprobe, the sender switches on it, and the domain
 * carries it between them. The names describe DELIVERY, not the ffmpeg work —
 * `transcode-video` covers the cheap audio-only re-encode too.
 */
export const VIDEO_DELIVERY_MODES = [
  /** Already playable. No ffmpeg at all. */
  'direct-video',
  /** Right codecs, wrong container. Stream copy; no pixels are touched. */
  'remux-video',
  /** A codec Telegram cannot stream, not worth re-encoding. Sent as a file. */
  'direct-document',
  /** Re-encoded, then sent as a video. */
  'transcode-video',
] as const;
export type VideoDeliveryMode = (typeof VIDEO_DELIVERY_MODES)[number];

/**
 * A progress sample. Every field but `downloadedBytes` is optional on purpose:
 * TikTok and Instagram routinely report no total size at all, and a UI that
 * assumes a percentage exists shows "NaN%" the moment it meets one.
 */
export interface DownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes?: number | undefined;
  readonly percent?: number | undefined;
  readonly speedBytesPerSecond?: number | undefined;
  readonly etaSeconds?: number | undefined;
}
