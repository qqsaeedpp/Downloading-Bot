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
