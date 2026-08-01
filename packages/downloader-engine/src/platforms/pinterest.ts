import { MediaPlatform } from '@tgtools/shared';
import type { PlatformDefinition, PlatformDownloadPolicy } from './platform-definition.js';
import {
  COMMON_TRACKING_PARAMS,
  defineHostPatterns,
  matchesAnyPattern,
} from './platform-definition.js';

/**
 * Pinterest runs a long list of country domains. They are enumerated rather
 * than matched with a wildcard: `pinterest\..+` would happily accept
 * `pinterest.attacker.test`.
 */
const COUNTRY_SUFFIXES = [
  'com',
  'ca',
  'fr',
  'de',
  'es',
  'it',
  'jp',
  'ph',
  'nz',
  'se',
  'at',
  'ch',
  'dk',
  'pt',
  'ie',
  'nl',
  'ru',
  'cl',
  'info',
  'kr',
  'co\\.uk',
  'com\\.au',
  'com\\.mx',
  'co\\.kr',
].join('|');

const HOST_PATTERNS = defineHostPatterns([
  String.raw`(?:www\.|[a-z]{2}\.)?pinterest\.(?:${COUNTRY_SUFFIXES})`,
  String.raw`pin\.it`,
]);

export const PINTEREST_SHORT_HOSTS: readonly string[] = ['pin.it'];

const MEDIA_PATH = /^\/(?:pin\/[A-Za-z0-9_-]+|[A-Za-z0-9_-]{5,})/;

export const pinterestPlatform: PlatformDefinition = {
  platform: MediaPlatform.Pinterest,
  hostPatterns: HOST_PATTERNS,

  supports(url: URL): boolean {
    if (!matchesAnyPattern(url.hostname, HOST_PATTERNS)) return false;
    if (PINTEREST_SHORT_HOSTS.includes(url.hostname.toLowerCase())) return url.pathname.length > 1;
    return MEDIA_PATH.test(url.pathname);
  },

  createPolicy(): PlatformDownloadPolicy {
    return {
      platform: MediaPlatform.Pinterest,
      preferProgressive: false,
      // The overwhelming majority of pins are stills, and a pin that does carry
      // video still has an image worth offering.
      imageFirst: true,
      servesStandaloneImages: true,
      supportsAudioExtraction: false,
      retryWithoutCookies: false,
      shortLinkHosts: PINTEREST_SHORT_HOSTS,
      extraArgs: [],
      strippableQueryParams: [
        ...COMMON_TRACKING_PARAMS,
        'nic_v1',
        'nic_v2',
        'invite_code',
        'sender',
      ],
    };
  },
};
