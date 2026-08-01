import type { MediaPlatform } from '@tgtools/shared';

/**
 * A link that has already been validated, normalised and attributed to a
 * platform. Constructed only by the infrastructure adapter that owns the URL
 * guard, so its existence is proof that the checks ran.
 */
export interface MediaUrl {
  /** Exactly what the user sent, minus the fragment. */
  readonly original: string;
  /** Canonical: lowercase host, tracking parameters removed, ordered query. */
  readonly normalized: string;
  /** SHA-256 of `normalized`. The cache key, and what gets indexed. */
  readonly hash: string;
  readonly platform: MediaPlatform;
}

/**
 * What we are willing to write down.
 *
 * A media URL can carry a signed CDN token or a per-share identifier, and a
 * database backup outlives the reason it was taken. With
 * `STORE_FULL_SOURCE_URL` off — the default — only the query-free form is
 * persisted, which is enough to recognise a job and not enough to replay
 * someone's authenticated link.
 */
export interface StorableUrl {
  readonly sourceUrl: string;
  readonly normalizedUrl: string;
  readonly normalizedUrlHash: string;
}
