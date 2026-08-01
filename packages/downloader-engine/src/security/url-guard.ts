import { isIP } from 'node:net';
import type { MediaPlatform } from '@tgtools/shared';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import type { PlatformRegistry } from '../platforms/registry.js';
import { inspectIpAddress } from './ip-rules.js';

/**
 * A URL long enough to matter is a URL doing something other than naming a
 * post. Browsers cap around 2 KB; extractors far lower.
 */
const MAX_URL_LENGTH = 2_048;

export interface SafeMediaUrl {
  /** Exactly as the user sent it, minus the fragment. */
  readonly originalUrl: string;
  /**
   * What to hand the extractor.
   *
   * Identical to `originalUrl` unless the platform defines a canonical shape.
   * For YouTube it is the bare `watch?v=<id>` form, which is how playlist and
   * timestamp context is prevented from reaching yt-dlp.
   */
  readonly requestUrl: string;
  /** Canonical form: lowercase host, no tracking params, no fragment. Cache key. */
  readonly normalizedUrl: string;
  readonly platform: MediaPlatform;
  readonly url: URL;
  /** Host resolves nowhere by itself; the real target is behind a redirect. */
  readonly isShortLink: boolean;
}

/**
 * The single gate every user-supplied URL passes through before it reaches
 * yt-dlp, `fetch`, or the database.
 *
 * The checks run in a deliberate order — cheapest and most decisive first — so
 * that a hostile input is rejected before anything touches the network.
 */
export class UrlGuard {
  constructor(private readonly registry: PlatformRegistry) {}

  parse(rawUrl: string): SafeMediaUrl {
    const candidate = rawUrl.trim();

    if (candidate.length === 0 || candidate.length > MAX_URL_LENGTH) {
      throw new EngineError(EngineFailureCode.InvalidUrl, 'URL is empty or unreasonably long', {
        context: { length: candidate.length },
      });
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new EngineError(EngineFailureCode.InvalidUrl, 'URL could not be parsed');
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new EngineError(
        EngineFailureCode.InvalidUrl,
        `Refusing protocol "${url.protocol}" — only http and https are allowed`,
      );
    }

    // Embedded credentials serve no purpose on a public post, and they are a
    // classic way to smuggle a different authority past a naive host check
    // (`https://instagram.com@evil.test/`, which parses with host `evil.test`).
    if (url.username !== '' || url.password !== '') {
      throw new EngineError(EngineFailureCode.InvalidUrl, 'URL must not embed credentials');
    }

    const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
    if (hostname === '') {
      throw new EngineError(EngineFailureCode.InvalidUrl, 'URL has no host');
    }

    // A literal IPv6 host keeps its brackets in `URL.hostname`, so strip them
    // before asking whether this is an address at all.
    const bareHost = hostname.replace(/^\[|\]$/g, '');

    // No supported platform is ever addressed by a bare IP, so refusing the
    // whole class here removes an entire family of SSRF payloads before the
    // per-range rules even have to run.
    if (isIP(bareHost) !== 0) {
      const verdict = inspectIpAddress(bareHost);
      throw new EngineError(
        EngineFailureCode.InvalidUrl,
        verdict.allowed
          ? 'Refusing a bare IP address; media links are addressed by name'
          : `Refusing a non-public address (${verdict.reason ?? 'blocked range'})`,
      );
    }

    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      throw new EngineError(EngineFailureCode.InvalidUrl, 'Refusing a loopback host name');
    }

    // A non-standard port on a platform domain means the request is aimed at
    // something other than the platform.
    if (url.port !== '') {
      throw new EngineError(
        EngineFailureCode.InvalidUrl,
        'Refusing an explicit port; platform links use the default one',
      );
    }

    url.hostname = hostname;
    url.hash = '';

    const definition = this.registry.detect(url);
    if (definition === undefined) {
      throw new EngineError(
        EngineFailureCode.UnsupportedPlatform,
        this.registry.isKnownHost(hostname)
          ? 'Host is supported but the link does not point at a single post'
          : 'No supported platform claims this host',
        { context: { host: hostname } },
      );
    }

    const policy = definition.createPolicy();
    // Canonicalisation runs AFTER the host and path checks, never before: it
    // rebuilds a URL, and rebuilding an unvalidated one would hand the checks a
    // different string from the one that reaches the extractor.
    const canonical = definition.canonicalize?.(url) ?? url;
    const normalized = normalizeUrl(canonical, policy.strippableQueryParams);

    return {
      originalUrl: url.toString(),
      requestUrl: canonical.toString(),
      normalizedUrl: normalized,
      platform: definition.platform,
      url,
      isShortLink: policy.shortLinkHosts.includes(hostname),
    };
  }

  /**
   * Re-check a redirect target. Same rules, plus the requirement that the hop
   * lands on a platform we already trust — so the resolver can never be talked
   * into fetching an arbitrary host.
   */
  parseRedirectTarget(rawUrl: string, base: URL): SafeMediaUrl {
    let absolute: string;
    try {
      absolute = new URL(rawUrl, base).toString();
    } catch {
      throw new EngineError(EngineFailureCode.InvalidUrl, 'Redirect target could not be parsed');
    }
    return this.parse(absolute);
  }
}

/**
 * Canonical form used as the cache key and stored alongside the job.
 *
 * Two people sharing the same reel produce URLs that differ only in a share
 * identifier; without normalisation they are two cache misses and two
 * downloads.
 */
export function normalizeUrl(url: URL, strippableParams: readonly string[]): string {
  const normalized = new URL(url.toString());
  normalized.hash = '';
  normalized.username = '';
  normalized.password = '';
  normalized.hostname = normalized.hostname.replace(/\.$/, '').toLowerCase();
  normalized.protocol = 'https:';

  for (const parameter of strippableParams) normalized.searchParams.delete(parameter);
  // Stable ordering, so `?a=1&b=2` and `?b=2&a=1` hash identically.
  normalized.searchParams.sort();

  // A trailing slash is cosmetic everywhere we support, but it splits the cache.
  if (normalized.pathname.length > 1 && normalized.pathname.endsWith('/')) {
    normalized.pathname = normalized.pathname.replace(/\/+$/, '');
  }

  return normalized.toString();
}
