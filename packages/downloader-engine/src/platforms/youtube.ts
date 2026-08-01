import { MediaPlatform } from '@tgtools/shared';
import type { PlatformDefinition, PlatformDownloadPolicy } from './platform-definition.js';
import {
  COMMON_TRACKING_PARAMS,
  defineHostPatterns,
  matchesAnyPattern,
} from './platform-definition.js';

/**
 * Every host is anchored at both ends by `defineHostPatterns`, which is what
 * keeps `youtube.com.evil.example`, `notyoutube.com` and `youtu.be.evil.example`
 * out. The subdomains are enumerated rather than wildcarded for the same
 * reason: `.*\.youtube\.com` would also accept an attacker-controlled host if
 * YouTube ever wildcarded its own DNS.
 */
const HOST_PATTERNS = defineHostPatterns([
  String.raw`(?:www\.|m\.|music\.)?youtube\.com`,
  String.raw`(?:www\.)?youtu\.be`,
  String.raw`(?:www\.)?youtube-nocookie\.com`,
]);

/**
 * YouTube ids are 11 characters today, but the range is deliberately loose:
 * pinning the length exactly would break the day YouTube widens it, and the
 * character class is what actually matters — it is what stops a path segment
 * from smuggling a slash, a dot or a query separator into the canonical URL we
 * rebuild below.
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/;

/** Path prefixes that are followed by a bare video id. */
const ID_BEARING_PREFIXES = new Set(['shorts', 'live', 'embed', 'v', 'e']);

/**
 * The id of the single video a URL names, or `undefined` when it names none.
 *
 * A channel, the home page, a search result and a bare `/playlist?list=` all
 * return `undefined`, which is what turns them into a precise "this link does
 * not point at a single post" instead of a confusing extractor failure later.
 */
export function extractYouTubeVideoId(url: URL): string | undefined {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const first = segments[0];

  // youtu.be carries the id in the path, so it needs no network round trip and
  // is deliberately NOT registered as a short link.
  if (host === 'youtu.be') return validId(first);

  if (first === 'watch') return validId(url.searchParams.get('v') ?? undefined);

  if (first !== undefined && ID_BEARING_PREFIXES.has(first)) return validId(segments[1]);

  // `/playlist?list=…`, `/@channel`, `/feed/…`, `/results?…` — no single video.
  return undefined;
}

function validId(candidate: string | undefined): string | undefined {
  return candidate !== undefined && VIDEO_ID.test(candidate) ? candidate : undefined;
}

export const youtubePlatform: PlatformDefinition = {
  platform: MediaPlatform.YouTube,
  hostPatterns: HOST_PATTERNS,

  supports(url: URL): boolean {
    if (!matchesAnyPattern(url.hostname, HOST_PATTERNS)) return false;
    return extractYouTubeVideoId(url) !== undefined;
  },

  /**
   * Collapse every shape onto `https://www.youtube.com/watch?v=<id>`.
   *
   * This is what makes the cache work — the same video reaches us as a
   * `youtu.be` link, a Shorts link and a watch link with a timestamp — and it
   * is also the playlist safeguard: rebuilding the URL from the id alone drops
   * `list` and `index`, so the extractor is handed exactly the video the user
   * pointed at and nothing else.
   */
  canonicalize(url: URL): URL {
    const videoId = extractYouTubeVideoId(url);
    if (videoId === undefined) return url;
    const canonical = new URL('https://www.youtube.com/watch');
    canonical.searchParams.set('v', videoId);
    return canonical;
  },

  createPolicy(): PlatformDownloadPolicy {
    return {
      platform: MediaPlatform.YouTube,
      ytdlpExtractorKey: 'youtube',
      // YouTube labels its formats accurately, so the height filters land where
      // they should; there is no unlabelled pre-muxed file to shortcut to.
      preferProgressive: false,
      imageFirst: false,
      // YouTube never serves a standalone still. Saying so is what keeps a
      // blocked extraction from being mistaken for a photo, and what lets the
      // real "sign in to confirm you're not a bot" reach the user.
      servesStandaloneImages: false,
      supportsAudioExtraction: true,
      // A YouTube bot check is answered BY cookies, so dropping them and trying
      // again is the one thing guaranteed not to help.
      retryWithoutCookies: false,
      shortLinkHosts: [],
      extraArgs: [],
      strippableQueryParams: [
        ...COMMON_TRACKING_PARAMS,
        'list',
        'index',
        'start_radio',
        'ab_channel',
        'pp',
        'si',
        't',
        'time_continue',
        'feature',
        'rv',
      ],
    };
  },
};
