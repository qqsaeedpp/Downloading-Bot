import { createNoopLogger } from '@tgtools/shared';
import { describe, expect, it, vi } from 'vitest';
import { withStaleCookieRetry } from './stale-cookie-retry.js';

const options = {
  cookies: 'cookie-jar',
  allowRetry: true,
  logger: createNoopLogger(),
  platform: 'instagram',
};

describe('withStaleCookieRetry', () => {
  it('passes the cookies through on the happy path', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    await expect(withStaleCookieRetry(options, run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('cookie-jar');
  });

  it('retries anonymously when the failure looks like a dead session', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('ERROR: Requested content is not available'))
      .mockResolvedValueOnce('recovered');

    // A stale session is worse than none: Instagram answers an invalidated
    // sessionid with a flat 404 on a reel that resolves fine unauthenticated.
    await expect(withStaleCookieRetry(options, run)).resolves.toBe('recovered');
    expect(run).toHaveBeenNthCalledWith(1, 'cookie-jar');
    expect(run).toHaveBeenNthCalledWith(2, undefined);
  });

  it('retries at most once', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ERROR: login required'));
    await expect(withStaleCookieRetry(options, run)).rejects.toThrow('login required');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrelated failure', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ERROR: No space left on device'));
    // Retrying every error would double the load on an extractor that already
    // said no.
    await expect(withStaleCookieRetry(options, run)).rejects.toThrow('No space left');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the platform policy forbids it', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ERROR: login required'));
    await expect(withStaleCookieRetry({ ...options, allowRetry: false }, run)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not retry when there were no cookies to begin with', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ERROR: login required'));
    await expect(withStaleCookieRetry({ ...options, cookies: undefined }, run)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(undefined);
  });
});

/**
 * The exact production sequence this exists for, captured verbatim:
 *
 *   WARNING: [youtube] The provided YouTube account cookies are no longer valid.
 *   ERROR:   [youtube] Sign in to confirm you're not a bot.
 *
 * yt-dlp buries the actionable half in a warning and ends on the generic one.
 * The operator reads "platform blocked", concludes the server's address is
 * burned, and goes shopping for a residential proxy — when the real fix was to
 * re-export a cookie file that had been silently rotated.
 */
describe('a cookie file the platform rejected', () => {
  const stderr =
    'WARNING: [youtube] The provided YouTube account cookies are no longer valid. ' +
    'They have likely been rotated in the browser as a security measure.\n' +
    "ERROR: [youtube] 9BrUmidnzo0: Sign in to confirm you're not a bot.";

  function recordingLogger() {
    const errors: string[] = [];
    const base = createNoopLogger();
    return {
      errors,
      logger: { ...base, error: (message: string) => errors.push(message), child: () => base },
    };
  }

  it('is reported to the operator even when anonymous retry is impossible', async () => {
    // YouTube sets retryWithoutCookies: false — its check is answered BY an
    // account, so dropping them cannot help. That is a reason not to RETRY, not
    // a reason to stay silent about a dead credential.
    const { errors, logger } = recordingLogger();
    const run = vi.fn().mockRejectedValue(new Error(stderr));

    await expect(
      withStaleCookieRetry(
        { cookies: 'jar', allowRetry: false, logger, platform: 'youtube' },
        run,
      ),
    ).rejects.toThrow();

    expect(run).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/re-export/i);
  });

  it('still surfaces the original failure rather than replacing it', async () => {
    // The bot-check error is what the mapper classifies. Swallowing it here
    // would turn a typed PLATFORM_BLOCKED into a generic internal error.
    const { logger } = recordingLogger();
    const run = vi.fn().mockRejectedValue(new Error(stderr));

    await expect(
      withStaleCookieRetry({ cookies: 'jar', allowRetry: false, logger, platform: 'youtube' }, run),
    ).rejects.toThrow(/not a bot/);
  });

  it('says nothing when no cookie file was supplied at all', async () => {
    // Without a cookie there is no dead credential to report, and the same bot
    // check means something entirely different.
    const { errors, logger } = recordingLogger();
    const run = vi.fn().mockRejectedValue(new Error(stderr));

    await expect(
      withStaleCookieRetry(
        { cookies: undefined, allowRetry: false, logger, platform: 'youtube' },
        run,
      ),
    ).rejects.toThrow();

    expect(errors).toEqual([]);
  });

  it('does not cry "rejected cookie" at an ordinary private video', async () => {
    // `matchesStaleSession` is deliberately broad, and reusing it here would
    // blame the operator's cookie for a video that is simply private.
    const { errors, logger } = recordingLogger();
    const run = vi.fn().mockRejectedValue(new Error('ERROR: [youtube] Private video. Sign in.'));

    await expect(
      withStaleCookieRetry({ cookies: 'jar', allowRetry: false, logger, platform: 'youtube' }, run),
    ).rejects.toThrow();

    expect(errors).toEqual([]);
  });

  it('reports the rejection on a retrying platform too, then still retries', async () => {
    // Instagram both benefits from the anonymous retry AND needs its cookie
    // refreshed. The two are not alternatives.
    const { errors, logger } = recordingLogger();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('ERROR: [instagram] cookies are no longer valid'))
      .mockResolvedValueOnce('recovered');

    await expect(
      withStaleCookieRetry(
        { cookies: 'jar', allowRetry: true, logger, platform: 'instagram' },
        run,
      ),
    ).resolves.toBe('recovered');

    expect(errors).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
