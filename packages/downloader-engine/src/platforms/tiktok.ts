import { MediaPlatform } from '@tgtools/shared';
import type { PlatformDefinition, PlatformDownloadPolicy } from './platform-definition.js';
import {
  COMMON_TRACKING_PARAMS,
  defineHostPatterns,
  matchesAnyPattern,
} from './platform-definition.js';

const HOST_PATTERNS = defineHostPatterns([
  String.raw`(?:www\.|m\.)?tiktok\.com`,
  String.raw`(?:vm|vt|www)\.tiktok\.com`,
  // Regional mirrors resolve to the same extractor.
  String.raw`(?:www\.)?tiktok\.com\.[a-z]{2}`,
]);

/** `vm.` and `vt.` links carry no id at all — the path is a redirect token. */
export const TIKTOK_SHORT_HOSTS: readonly string[] = ['vm.tiktok.com', 'vt.tiktok.com'];

const MEDIA_PATH = /^\/(?:@[^/]+\/(?:video|photo)\/\d+|v\/\d+|t\/[A-Za-z0-9]+|[A-Za-z0-9]{5,})/;

export const tiktokPlatform: PlatformDefinition = {
  platform: MediaPlatform.TikTok,
  hostPatterns: HOST_PATTERNS,

  supports(url: URL): boolean {
    if (!matchesAnyPattern(url.hostname, HOST_PATTERNS)) return false;
    // A short link's path is opaque, so it can only be judged after resolution.
    if (TIKTOK_SHORT_HOSTS.includes(url.hostname.toLowerCase())) return url.pathname.length > 1;
    return MEDIA_PATH.test(url.pathname);
  },

  createPolicy(): PlatformDownloadPolicy {
    return {
      platform: MediaPlatform.TikTok,
      // TikTok's labelled formats are the good ones, and its progressive file
      // is already H.264 — no shortcut needed.
      preferProgressive: false,
      imageFirst: false,
      supportsAudioExtraction: true,
      // TikTok serves public videos fine without a session, and a bad session
      // does not produce the distinctive failure Instagram does.
      retryWithoutCookies: false,
      shortLinkHosts: TIKTOK_SHORT_HOSTS,
      extraArgs: [],
      strippableQueryParams: [
        ...COMMON_TRACKING_PARAMS,
        'is_from_webapp',
        'sender_device',
        'web_id',
        '_r',
        '_t',
        'checksum',
        'share_app_id',
        'share_link_id',
      ],
    };
  },
};
