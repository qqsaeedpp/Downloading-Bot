import { createPlatformRegistry, UrlGuard } from '@tgtools/downloader-engine';
import { MediaPlatform, stripUrlQuery } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';

const guard = new UrlGuard(createPlatformRegistry());

/**
 * Mirrors what `resolveUrl` stores when `STORE_FULL_SOURCE_URL` is false.
 * The worker later re-fetches this exact string, so it has to remain a URL that
 * names the media.
 */
function storedSourceUrl(rawUrl: string): string {
  return guard.parse(rawUrl).normalizedUrl;
}

describe('the URL persisted for the worker to re-fetch', () => {
  it('keeps the YouTube video id, which lives in the query string', () => {
    const stored = storedSourceUrl('https://www.youtube.com/watch?v=9BrUmidnzo0');

    // The regression, seen in production: the stored value was produced by a
    // blanket `stripUrlQuery`, so every YouTube job was queued as
    // `https://www.youtube.com/watch` — a URL that names no video at all.
    expect(stripUrlQuery('https://www.youtube.com/watch?v=9BrUmidnzo0')).toBe(
      'https://www.youtube.com/watch',
    );
    expect(stored).toContain('v=9BrUmidnzo0');
    expect(stored).not.toBe('https://www.youtube.com/watch');
  });

  it('still round-trips through the guard as the same video', () => {
    const stored = storedSourceUrl('https://youtu.be/9BrUmidnzo0?t=30');
    const reparsed = guard.parse(stored);

    expect(reparsed.platform).toBe(MediaPlatform.YouTube);
    expect(reparsed.normalizedUrl).toBe(stored);
  });

  it.each([
    ['https://www.instagram.com/reel/Cx1y2z3AbCd/', MediaPlatform.Instagram],
    ['https://www.tiktok.com/@someone/video/7234567890123456789', MediaPlatform.TikTok],
    ['https://www.pinterest.com/pin/1234567890/', MediaPlatform.Pinterest],
    ['https://x.com/someone/status/1700000000000000001', MediaPlatform.X],
    ['https://www.youtube.com/shorts/9BrUmidnzo0', MediaPlatform.YouTube],
  ])('stores a re-fetchable URL for %s', (rawUrl, platform) => {
    const stored = storedSourceUrl(rawUrl);
    const reparsed = guard.parse(stored);
    expect(reparsed.platform).toBe(platform);
  });

  it('has already dropped the tracking parameters, so nothing sensitive is kept', () => {
    // The privacy goal is met by normalisation, not by deleting the query
    // wholesale: per-share identifiers are removed by the platform policy.
    const stored = storedSourceUrl(
      'https://www.instagram.com/reel/Cx1y2z3AbCd/?igshid=SECRET123&utm_source=ig_web',
    );
    expect(stored).not.toContain('igshid');
    expect(stored).not.toContain('SECRET123');
    expect(stored).not.toContain('utm_source');
  });

  it('drops a YouTube playlist context while keeping the video', () => {
    const stored = storedSourceUrl(
      'https://www.youtube.com/watch?v=9BrUmidnzo0&list=PLsecret&index=7',
    );
    expect(stored).toContain('v=9BrUmidnzo0');
    expect(stored).not.toContain('list=');
    expect(stored).not.toContain('index=');
  });
});
