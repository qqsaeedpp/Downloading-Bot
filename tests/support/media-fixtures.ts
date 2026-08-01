import type { DownloadOption, MediaInfo } from '@tgtools/feature-downloader';
import { DownloadType, MediaKind, MediaPlatform } from '@tgtools/shared';

export const VIDEO_OPTIONS: readonly DownloadOption[] = [
  {
    id: 'v1080',
    type: DownloadType.Video,
    label: '1080p',
    height: 1080,
    audioBitrateKbps: undefined,
    estimatedBytes: 20_000_000,
    formatId: undefined,
  },
  {
    id: 'v720',
    type: DownloadType.Video,
    label: '720p',
    height: 720,
    audioBitrateKbps: undefined,
    estimatedBytes: 9_000_000,
    formatId: undefined,
  },
  {
    id: 'a192',
    type: DownloadType.Audio,
    label: '192 kbps',
    height: undefined,
    audioBitrateKbps: 192,
    estimatedBytes: 1_400_000,
    formatId: undefined,
  },
];

export const IMAGE_OPTION: DownloadOption = {
  id: 'image',
  type: DownloadType.Image,
  label: 'image',
  height: undefined,
  audioBitrateKbps: undefined,
  estimatedBytes: undefined,
  formatId: undefined,
};

export function instagramReelInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    sourceUrl: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
    platform: MediaPlatform.Instagram,
    title: 'A reel worth keeping',
    uploader: 'someone',
    durationSeconds: 27,
    thumbnailUrl: 'https://cdn.test/thumb.jpg',
    uploadDate: '2026-01-31',
    description: undefined,
    statistics: { viewCount: 4_200, likeCount: 99, commentCount: 7 },
    mediaKind: MediaKind.Video,
    requiredAuthentication: false,
    formats: [],
    availableOptions: VIDEO_OPTIONS,
    ...overrides,
  };
}

export function pinterestPinInfo(): MediaInfo {
  return {
    sourceUrl: 'https://www.pinterest.com/pin/1234567890/',
    platform: MediaPlatform.Pinterest,
    title: 'A pin',
    uploader: undefined,
    durationSeconds: undefined,
    thumbnailUrl: 'https://cdn.test/pin.jpg',
    uploadDate: undefined,
    description: undefined,
    statistics: { viewCount: undefined, likeCount: undefined, commentCount: undefined },
    mediaKind: MediaKind.Image,
    requiredAuthentication: false,
    formats: [],
    availableOptions: [IMAGE_OPTION],
  };
}
