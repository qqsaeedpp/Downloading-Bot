import type { MediaPlatform } from '@tgtools/shared';

/**
 * Where the engine gets a session from.
 *
 * Cookies never travel through the queue, the database or a job payload — they
 * are read here, at the moment of use, from a source the operator controls.
 * That is what keeps a Redis dump or a database backup from containing somebody's
 * live Instagram session.
 */
export interface CookieProvider {
  /** Netscape `cookies.txt` content, or undefined to run unauthenticated. */
  getCookies(platform: MediaPlatform): Promise<string | undefined>;
}

/** The default in every deployment that has not configured any cookies. */
export class NoCookieProvider implements CookieProvider {
  getCookies(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
}
