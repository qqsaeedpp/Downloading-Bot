import { MediaPlatform } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { EngineFailureCode } from '../errors/engine-error.js';
import { UrlGuard } from '../security/url-guard.js';
import { createPlatformRegistry } from './registry.js';

const guard = new UrlGuard(createPlatformRegistry());

describe('YouTube URL recognition', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'a standard watch URL'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'no www'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'the mobile host'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube Music'],
    ['https://youtu.be/dQw4w9WgXcQ', 'the short host'],
    ['https://www.youtu.be/dQw4w9WgXcQ', 'the short host with www'],
    ['https://www.youtube.com/shorts/abc123XYZ_-', 'Shorts'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'a live permalink'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'an embed URL'],
    ['https://www.youtube.com/v/dQw4w9WgXcQ', 'the legacy /v/ form'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'the no-cookie domain'],
  ])('recognises %s (%s)', (url) => {
    expect(guard.parse(url).platform).toBe(MediaPlatform.YouTube);
  });

  it('is not a short link, so no redirect resolution is attempted', () => {
    // youtu.be encodes the video id in its path; it needs no network round trip.
    expect(guard.parse('https://youtu.be/dQw4w9WgXcQ').isShortLink).toBe(false);
  });
});

describe('YouTube URL normalisation', () => {
  it('collapses every shape of the same video onto one cache key', () => {
    const canonical = guard.parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ').normalizedUrl;

    for (const variant of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&si=abcdef',
    ]) {
      // One video shared eight ways must be one inspection, not eight.
      expect(guard.parse(variant).normalizedUrl, variant).toBe(canonical);
    }
  });

  it('keeps a timestamp out of the identity of the video', () => {
    expect(guard.parse('https://youtu.be/dQw4w9WgXcQ?t=42').normalizedUrl).toBe(
      guard.parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ').normalizedUrl,
    );
  });

  it('resolves a playlist link to the single video it explicitly names', () => {
    // The app has no UI for choosing between playlist items, so the honest
    // behaviour is to take the video the URL actually points at and drop the
    // list context rather than silently downloading item one of two hundred.
    const parsed = guard.parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123&index=7');
    expect(parsed.platform).toBe(MediaPlatform.YouTube);
    expect(parsed.normalizedUrl).toBe(
      guard.parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ').normalizedUrl,
    );
  });
});

describe('YouTube host confusion', () => {
  it.each([
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be.evil.example/dQw4w9WgXcQ',
    'https://myyoutube.com/watch?v=abc',
    'https://youtube.evil.example/watch?v=abc',
    'https://www.youtube-nocookie.com.evil.example/embed/abc',
  ])('refuses the look-alike host %s', (url) => {
    let thrown: unknown;
    try {
      guard.parse(url);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, `expected ${url} to be refused`).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(EngineFailureCode.UnsupportedPlatform);
  });

  it('refuses a YouTube host that is not pointing at a video', () => {
    // A channel or the home page has nothing to download; saying so precisely
    // beats a confusing extractor failure later.
    for (const url of [
      'https://www.youtube.com/',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/feed/subscriptions',
      'https://www.youtube.com/results?search_query=cats',
    ]) {
      expect(() => guard.parse(url), url).toThrow();
    }
  });

  it('refuses a bare playlist link with no video in it', () => {
    // `/playlist?list=…` names no single video, and the app does not download
    // playlists, so there is nothing safe to select.
    expect(() => guard.parse('https://www.youtube.com/playlist?list=PLabc123')).toThrow();
  });
});
