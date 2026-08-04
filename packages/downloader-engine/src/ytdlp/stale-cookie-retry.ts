import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import { matchesRejectedCookies, matchesStaleSession } from '../errors/ytdlp-error-patterns.js';

export interface StaleCookieRetryOptions {
  readonly cookies: string | undefined;
  readonly allowRetry: boolean;
  readonly logger: Logger;
  readonly platform: string;
}

/**
 * Run an operation with cookies and, if the failure looks like a dead session,
 * run it exactly once more without them.
 *
 * The counter-intuitive part: a stale session is WORSE than no session at all.
 * Instagram answers an invalidated `sessionid` with a flat 404 while the very
 * same public reel resolves fine unauthenticated, so a deployment with
 * day-old cookies fails on links it could otherwise serve. Retrying anonymously
 * both rescues those links and tells the operator, in the log, that the cookies
 * need refreshing.
 *
 * Exactly once, and only on a matching failure: retrying every error would
 * double the load on an extractor that already said no.
 */
export async function withStaleCookieRetry<T>(
  options: StaleCookieRetryOptions,
  run: (cookies: string | undefined) => Promise<T>,
): Promise<T> {
  const { cookies, allowRetry, logger, platform } = options;

  // No credential was supplied, so there is no dead credential to diagnose and
  // nothing to drop for a second attempt.
  if (cookies === undefined) return run(cookies);

  try {
    return await run(cookies);
  } catch (error: unknown) {
    const message = describeError(error);

    // Reported whether or not a retry is possible. YouTube cannot retry
    // anonymously — its check is answered BY an account — but that is a reason
    // not to RETRY, not a reason to stay silent about a rotated cookie. Without
    // this the operator reads the generic "platform blocked" that yt-dlp ends
    // on and goes looking for a residential proxy, when the fix was to export
    // the cookie file again.
    if (matchesRejectedCookies(message)) {
      logger.error(
        'the platform REJECTED the supplied cookie file — it has been rotated or expired. ' +
          'Re-export it from a private browsing window and close that window WITHOUT signing ' +
          'out, or unset the cookie path to run unauthenticated.',
        { platform },
      );
    }

    if (!allowRetry || !matchesStaleSession(message)) throw error;

    logger.warn(
      'authenticated attempt failed in a way that suggests an expired session; retrying anonymously — refresh this platform cookie file',
      { platform },
    );
    return run(undefined);
  }
}
