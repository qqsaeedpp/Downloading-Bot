import type { MediaPlatform } from '@tgtools/shared';

/**
 * Everything the engine needs to know about how one platform behaves. It is a
 * data description, not a branch: the alternative — a `switch (platform)` in the
 * selector, another in the downloader, a third in the error mapper — is exactly
 * the shape that makes adding the fifth platform a week's work instead of an
 * afternoon's.
 */
export interface PlatformDownloadPolicy {
  readonly platform: MediaPlatform;

  /**
   * yt-dlp's own name for this extractor, which is not always our slug — X is
   * `twitter` to yt-dlp. Needed to address `--extractor-args`, so an operator
   * can tune a platform's extraction from the environment without a code
   * change. That matters most for YouTube, where the workaround for a bot
   * check changes faster than any release cycle.
   */
  readonly ytdlpExtractorKey: string;

  /**
   * Try the unlabelled pre-muxed file before the labelled renditions.
   *
   * Instagram publishes every reel twice: as VP9 DASH renditions yt-dlp can
   * describe, and as the same picture in a progressive MP4 whose codec and
   * height it cannot read at all (measured: H.264 + AAC, 720x1280). Height
   * filters therefore always land on the VP9 copy, which then costs a re-encode
   * to become playable on a phone. Asking for the pre-muxed file first gets the
   * same picture, already H.264, for free.
   *
   * Only applied when the user asked for the best available quality — the
   * pre-muxed file has no height metadata, so honouring a "480p" request with
   * it would silently hand back something else.
   */
  readonly preferProgressive: boolean;

  /** Treat a still image as the primary product, not as a fallback. */
  readonly imageFirst: boolean;

  /**
   * Whether a post on this platform can legitimately BE a standalone still.
   *
   * Two things hang off this, and both went wrong when it did not exist:
   *
   * - It gates `--ignore-no-formats-error` during inspection. That flag exists
   *   so an image-only pin returns JSON instead of aborting — but on a platform
   *   that only ever serves video it converts a real failure ("Sign in to
   *   confirm you're not a bot") into a silent document with no formats.
   * - It gates the image classification. Every YouTube video has a thumbnail,
   *   so "no video formats + a thumbnail" was read as "this is an image", and a
   *   36-minute video was offered as a picture.
   */
  readonly servesStandaloneImages: boolean;

  /** Whether offering an audio-only download makes sense at all. */
  readonly supportsAudioExtraction: boolean;

  /**
   * Retry once without cookies if an authenticated attempt fails. Correct where
   * a stale session is *worse* than none, which is true of Instagram and X.
   */
  readonly retryWithoutCookies: boolean;

  /** Hosts that carry no media themselves and only ever redirect. */
  readonly shortLinkHosts: readonly string[];

  /** Appended verbatim to every yt-dlp invocation for this platform. */
  readonly extraArgs: readonly string[];

  /** Query parameters that carry no meaning and only defeat caching. */
  readonly strippableQueryParams: readonly string[];
}

export interface PlatformDefinition {
  readonly platform: MediaPlatform;
  readonly hostPatterns: readonly RegExp[];
  supports(url: URL): boolean;
  createPolicy(): PlatformDownloadPolicy;

  /**
   * Rewrite a URL into the platform's canonical shape.
   *
   * Optional, because most platforms have exactly one URL per post. YouTube has
   * eight — `youtu.be`, `/shorts`, `/embed`, `/live`, `music.`, `m.`, plus
   * playlist and timestamp context — and without collapsing them, one video
   * shared eight ways is eight cache misses and eight extractor calls.
   *
   * It is also how playlist context is discarded: the canonical form names only
   * the video the URL explicitly referenced, so yt-dlp cannot wander into item
   * one of two hundred.
   *
   * Returning the URL unchanged is always valid.
   */
  canonicalize?(url: URL): URL;
}

/** Tracking junk every platform accumulates; never part of media identity. */
export const COMMON_TRACKING_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'ref',
  'ref_src',
  'ref_url',
  's',
];

/**
 * Build a definition from a host list. The matcher is anchored at both ends so
 * that `instagram.com.evil.test` cannot pass for Instagram — an unanchored
 * `includes('instagram.com')` is the single most common way a URL allow-list
 * turns into an SSRF hole.
 */
export function defineHostPatterns(hosts: readonly string[]): readonly RegExp[] {
  return hosts.map((host) => new RegExp(`^${host}$`, 'i'));
}

export function matchesAnyPattern(hostname: string, patterns: readonly RegExp[]): boolean {
  // Trailing dots make `instagram.com.` a distinct, fully-qualified name that
  // resolves identically — strip it before matching rather than after deciding.
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  return patterns.some((pattern) => pattern.test(normalized));
}
