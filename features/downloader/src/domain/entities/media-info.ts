import type { MediaKind, MediaPlatform } from '@tgtools/shared';
import type { DownloadOption } from '../value-objects/download-option.js';

export interface MediaFormat {
  readonly id: string;
  readonly ext: string;
  readonly height: number | undefined;
  readonly width: number | undefined;
  readonly videoCodec: string | undefined;
  readonly audioCodec: string | undefined;
  readonly filesizeBytes: number | undefined;
}

export interface MediaStatistics {
  readonly viewCount: number | undefined;
  readonly likeCount: number | undefined;
  readonly commentCount: number | undefined;
}

/**
 * What the bot knows about a link before anything has been downloaded — that
 * is, everything the quality card shows.
 *
 * Every field but `sourceUrl`, `platform` and `title` is optional, and that is
 * not defensiveness: Pinterest supplies no duration, X supplies no view count,
 * and a card that assumes otherwise renders "undefined" to a real person.
 */
export interface MediaInfo {
  readonly sourceUrl: string;
  readonly platform: MediaPlatform;
  readonly title: string;
  readonly uploader: string | undefined;
  readonly durationSeconds: number | undefined;
  readonly thumbnailUrl: string | undefined;
  readonly uploadDate: string | undefined;
  readonly description: string | undefined;
  readonly statistics: MediaStatistics;
  readonly mediaKind: MediaKind;
  /** Obtained using operator cookies, so it must not be cached for everyone. */
  readonly requiredAuthentication: boolean;
  readonly formats: readonly MediaFormat[];
  readonly availableOptions: readonly DownloadOption[];
}
