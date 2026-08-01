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
      // A missing or unreadable file must degrade to anonymous access, not to a
      // failed job — the mount may simply not be configured on this host.
      this.options.logger.warn('cookie file could not be read; continuing without it', {
        platform,
        path,
        error: describeError(error),
      });
      this.#remember(platform, undefined, 0);
      return undefined;
    }
  }

  #remember(platform: MediaPlatform, content: string | undefined, mtimeMs: number): void {
    this.#cache.set(platform, { content, readAtMs: Date.now(), mtimeMs });
  }
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
