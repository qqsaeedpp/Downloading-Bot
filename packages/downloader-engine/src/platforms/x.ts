import { MediaPlatform } from '@tgtools/shared';
import type { PlatformDefinition, PlatformDownloadPolicy } from './platform-definition.js';
import {
  COMMON_TRACKING_PARAMS,
  defineHostPatterns,
  matchesAnyPattern,
} from './platform-definition.js';

const HOST_PATTERNS = defineHostPatterns([
  String.raw`(?:www\.|mobile\.|m\.)?(?:twitter|x)\.com`,
  String.raw`t\.co`,
]);

export const X_SHORT_HOSTS: readonly string[] = ['t.co'];

/** `/{handle}/status/{id}` — the only shape that identifies a single post. */
const MEDIA_PATH = /^\/(?:i\/web\/status\/\d+|[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+)/;

export const xPlatform: PlatformDefinition = {
  platform: MediaPlatform.X,
  hostPatterns: HOST_PATTERNS,

  supports(url: URL): boolean {
    if (!matchesAnyPattern(url.hostname, HOST_PATTERNS)) return false;
    if (X_SHORT_HOSTS.includes(url.hostname.toLowerCase())) return url.pathname.length > 1;
    return MEDIA_PATH.test(url.pathname);
  },

  createPolicy(): PlatformDownloadPolicy {
    return {
      platform: MediaPlatform.X,
      preferProgressive: false,
      imageFirst: false,
      supportsAudioExtraction: true,
      // X answers a dead session with the same "content is not available" it
      // uses for a genuinely gated post, so an anonymous second attempt is the
      // only way to tell the two apart.
      retryWithoutCookies: true,
      shortLinkHosts: X_SHORT_HOSTS,
      extraArgs: [],
      strippableQueryParams: [...COMMON_TRACKING_PARAMS, 't', 'twclid', 'cxt'],
    };
  },
};
