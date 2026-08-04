import { readFile, stat } from 'node:fs/promises';
import type { Logger, MediaPlatform } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import type { CookieProvider } from './cookie-provider.js';

export interface FileCookieProviderOptions {
  /** Absolute paths to Netscape `cookies.txt` files, keyed by platform. */
  readonly paths: Readonly<Partial<Record<MediaPlatform, string>>>;
  readonly logger: Logger;
  /** How long a read is reused before the file is consulted again. */
  readonly cacheTtlMs?: number;
}

interface CacheEntry {
  readonly content: string | undefined;
  readonly readAtMs: number;
  readonly mtimeMs: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Reads cookies from files mounted into the container (a Docker secret, or a
 * read-only bind mount).
 *
 * Cached briefly rather than read per job: an operator refreshing a session
 * should see the effect within a minute without a restart, but a busy worker
 * should not stat the same file forty times a minute either.
 */
export class FileCookieProvider implements CookieProvider {
  readonly #cache = new Map<MediaPlatform, CacheEntry>();
  readonly #ttlMs: number;

  constructor(private readonly options: FileCookieProviderOptions) {
    this.#ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async getCookies(platform: MediaPlatform): Promise<string | undefined> {
    const path = this.options.paths[platform];
    if (path === undefined) return undefined;

    const cached = this.#cache.get(platform);
    if (cached !== undefined && Date.now() - cached.readAtMs < this.#ttlMs) return cached.content;

    try {
      const stats = await stat(path);
      if (stats.size === 0) {
        // An empty file is how `touch cookies.txt` leaves things. Treating it as
        // "no cookies" is friendlier than failing every download.
        this.#remember(platform, undefined, stats.mtimeMs);
        return undefined;
      }
      const content = await readFile(path, 'utf8');
      if (!looksLikeNetscapeCookieJar(content)) {
        this.options.logger.warn(
          'cookie file is not in Netscape format and will be ignored; export it with a "# Netscape HTTP Cookie File" header',
          { platform, path },
        );
        this.#remember(platform, undefined, stats.mtimeMs);
        return undefined;
      }
      this.#remember(platform, content, stats.mtimeMs);
      return content;
    } catch (error: unknown) {
      // Still degrades to anonymous access rather than failing the job — but at
      // ERROR level, because a path was CONFIGURED and could not be used. That
      // is a misconfiguration, and treating it as a soft condition is how an
      // operator ends up believing cookies are in play while every request goes
      // out unauthenticated.
      this.options.logger.error(
        'cookie file is configured but unreadable; every request will go out UNAUTHENTICATED',
        {
          platform,
          path,
          hint: hintFor(error),
          error: describeError(error),
        },
      );
      this.#remember(platform, undefined, 0);
      return undefined;
    }
  }

  #remember(platform: MediaPlatform, content: string | undefined, mtimeMs: number): void {
    this.#cache.set(platform, { content, readAtMs: Date.now(), mtimeMs });
  }
}

/**
 * Name the fix, not just the failure.
 *
 * `EACCES` is the one an operator hits and cannot diagnose from the message
 * alone: the containers run as a non-root user, so a cookie file left owned by
 * root with `0600` is invisible to them — and every download then silently goes
 * out unauthenticated.
 *
 * The EACCES text names the DIRECTORY as well as the file, and deliberately so.
 * Reading a file requires the execute bit on every directory above it, so a
 * `secrets/` left at `0700 root:root` denies the read no matter what the file
 * itself allows. An earlier version of this hint mentioned only the file, and
 * the result was an operator running `chown` on it, seeing no change, and
 * reasonably concluding the mount was broken.
 */
function hintFor(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'EACCES' || code === 'EPERM') {
    return (
      'the containers run as uid 1001. Fix the DIRECTORY as well as the file — ' +
      'a read needs the execute bit on every directory above it: ' +
      '`chown -R 1001:1001 <dir> && chmod 755 <dir> && chmod 644 <dir>/<file>`'
    );
  }
  if (code === 'ENOENT') {
    return 'no such file — check the path is the one INSIDE the container (/run/secrets/...), not the host path';
  }
  if (code === 'EISDIR') {
    return 'this is a directory; Docker creates one when a bind-mount source is missing';
  }
  return 'check the mount, the path and the file ownership';
}

/** What a startup check found for one configured cookie file. */
export type CookieAccessReport =
  | { readonly platform: MediaPlatform; readonly kind: 'usable' }
  | { readonly platform: MediaPlatform; readonly kind: 'empty' }
  | { readonly platform: MediaPlatform; readonly kind: 'wrong-format' }
  | { readonly platform: MediaPlatform; readonly kind: 'unreadable'; readonly hint: string };

/**
 * Check every configured cookie file once, at startup.
 *
 * Cookies are otherwise read lazily, on the first job that needs one, so a
 * container that cannot read its cookie file looks perfectly healthy until a
 * user clicks a button. That produced the worst possible symptom: the bot
 * inspected a video, listed every quality with its size, and only then did the
 * worker — a DIFFERENT container, with its own mounts and its own environment —
 * fail on the download. The two diverging is invisible at deploy time and
 * obvious here.
 *
 * Reports rather than throws. A missing cookie is a degraded deployment, not a
 * broken one: most links need no credential at all.
 */
export async function reportCookieAccess(
  paths: Readonly<Partial<Record<MediaPlatform, string>>>,
  logger: Logger,
): Promise<readonly CookieAccessReport[]> {
  const reports: CookieAccessReport[] = [];

  for (const [platform, path] of Object.entries(paths) as [MediaPlatform, string][]) {
    try {
      const content = await readFile(path, 'utf8');
      if (content.trim() === '') {
        reports.push({ platform, kind: 'empty' });
        logger.warn('cookie file is empty; this platform will run unauthenticated', { platform });
      } else if (!looksLikeNetscapeCookieJar(content)) {
        reports.push({ platform, kind: 'wrong-format' });
        logger.error(
          'cookie file is not in Netscape format and will be ignored; export it with a ' +
            '"# Netscape HTTP Cookie File" header, not as JSON',
          { platform },
        );
      } else {
        reports.push({ platform, kind: 'usable' });
      }
    } catch (error: unknown) {
      const hint = hintFor(error);
      reports.push({ platform, kind: 'unreadable', hint });
      logger.error(
        'cookie file is configured but THIS CONTAINER cannot read it; every request for this ' +
          'platform will go out UNAUTHENTICATED. Note that the bot and the worker mount it ' +
          'separately — one working does not mean both do.',
        { platform, path, hint, error: describeError(error) },
      );
    }
  }

  return reports;
}

/**
 * yt-dlp accepts only the Netscape format and reports a confusing parse error
 * for anything else — usually a JSON export from a browser extension.
 */
export function looksLikeNetscapeCookieJar(content: string): boolean {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return false;
  if (lines[0]?.startsWith('# Netscape HTTP Cookie File') === true) return true;
  if (lines[0]?.startsWith('# HTTP Cookie File') === true) return true;
  // Some exporters drop the header; a tab-separated seven-field row is the
  // format's actual signature.
  return lines.some((line) => !line.startsWith('#') && line.split('\t').length === 7);
}
