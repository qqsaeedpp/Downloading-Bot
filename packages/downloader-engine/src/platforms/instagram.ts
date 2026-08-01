import { MediaPlatform } from '@tgtools/shared';
import type { PlatformDefinition, PlatformDownloadPolicy } from './platform-definition.js';
import {
  COMMON_TRACKING_PARAMS,
  defineHostPatterns,
  matchesAnyPattern,
} from './platform-definition.js';

const HOST_PATTERNS = defineHostPatterns([
  String.raw`(?:www\.|m\.)?instagram\.com`,
  String.raw`(?:www\.)?instagr\.am`,
  String.raw`(?:www\.)?ig\.me`,
]);

/** Paths that actually carry media, as opposed to a profile or the explore feed. */
const MEDIA_PATH = /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv|share)\/[A-Za-z0-9_-]+/;

export const instagramPlatform: PlatformDefinition = {
  platform: MediaPlatform.Instagram,
  hostPatterns: HOST_PATTERNS,

  supports(url: URL): boolean {
    if (!matchesAnyPattern(url.hostname, HOST_PATTERNS)) return false;
    // A bare profile link has nothing to download; rejecting it here produces a
    // precise "unsupported link" instead of a confusing extractor failure.
    return MEDIA_PATH.test(url.pathname);
  },

  createPolicy(): PlatformDownloadPolicy {
    return {
      platform: MediaPlatform.Instagram,
      preferProgressive: true,
      imageFirst: false,
      servesStandaloneImages: true,
      supportsAudioExtraction: true,
      retryWithoutCookies: true,
      shortLinkHosts: ['ig.me'],
      extraArgs: [],
      // `igsh`/`igshid` are per-share identifiers: the same reel produces a
      // different one for every person who taps "copy link", which would turn
      // one cache entry into thousands.
      strippableQueryParams: [...COMMON_TRACKING_PARAMS, 'igshid', 'igsh', 'img_index'],
    };
  },
};
