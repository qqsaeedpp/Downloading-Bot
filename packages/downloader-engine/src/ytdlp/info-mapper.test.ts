import { MediaKind, MediaPlatform, createNoopLogger } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import { YtDlpInfoMapper, toIsoDate } from './info-mapper.js';

const mapper = new YtDlpInfoMapper(createNoopLogger());
const context = {
  sourceUrl: 'https://www.instagram.com/reel/abc',
  platform: MediaPlatform.Instagram,
  obtainedWithCookies: false,
};

describe('YtDlpInfoMapper', () => {
  it('maps a well-formed video document', () => {
    const info = mapper.map(
      {
        id: 'abc123',
        title: 'A reel',
        uploader: 'someone',
        duration: 27.4,
        thumbnail: 'https://cdn.test/t.jpg',
        upload_date: '20260131',
        view_count: 4200,
        like_count: 99,
        formats: [
          {
            format_id: '137',
            ext: 'mp4',
            height: 1080,
            width: 1920,
            vcodec: 'avc1.640028',
            acodec: 'none',
            filesize: 12_345,
            tbr: 2500,
          },
        ],
      },
      context,
    );

    expect(info.title).toBe('A reel');
    expect(info.uploader).toBe('someone');
    expect(info.durationSeconds).toBe(27.4);
    expect(info.uploadDate).toBe('2026-01-31');
    expect(info.statistics.viewCount).toBe(4200);
    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(info.formats[0]?.isVideoOnly).toBe(true);
  });

  it('survives a document where almost everything is missing', () => {
    // Pinterest supplies no duration, X supplies no view count. Assuming
    // otherwise renders "undefined" to a real person.
    const info = mapper.map({ id: 'pin1', formats: [] }, context);
    expect(info.title).toBe('pin1');
    expect(info.durationSeconds).toBeUndefined();
    expect(info.statistics.viewCount).toBeUndefined();
    expect(info.formats).toEqual([]);
  });

  it('drops an unparsable format instead of losing the whole document', () => {
    const info = mapper.map(
      {
        id: 'abc',
        title: 'x',
        formats: [
          { format_id: 'good', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 720 },
          { ext: 'mp4' },
          null,
          'garbage',
        ],
      },
      context,
    );
    expect(info.formats).toHaveLength(1);
    expect(info.formats[0]?.id).toBe('good');
  });

  it('accepts a numeric format id, which some extractors emit', () => {
    const info = mapper.map(
      { id: 'a', title: 'x', formats: [{ format_id: 137, ext: 'mp4', vcodec: 'avc1' }] },
      context,
    );
    expect(info.formats[0]?.id).toBe('137');
  });

  it('falls back to filesize_approx when no exact size is given', () => {
    const info = mapper.map(
      {
        id: 'a',
        title: 'x',
        formats: [{ format_id: '1', ext: 'mp4', vcodec: 'avc1', filesize_approx: 999 }],
      },
      context,
    );
    expect(info.formats[0]?.filesizeBytes).toBe(999);
  });

  it('classifies an image-only post', () => {
    const info = mapper.map(
      { id: 'pin', title: 'A pin', thumbnail: 'https://cdn.test/pin.jpg', formats: [] },
      { ...context, platform: MediaPlatform.Pinterest },
    );
    expect(info.mediaKind).toBe(MediaKind.Image);
  });

  it('classifies an audio-only source', () => {
    const info = mapper.map(
      {
        id: 'a',
        title: 'x',
        formats: [{ format_id: '1', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2' }],
      },
      context,
    );
    expect(info.mediaKind).toBe(MediaKind.Audio);
  });

  it('unwraps a carousel to its first entry, keeping the container title', () => {
    const info = mapper.map(
      {
        _type: 'playlist',
        title: 'Carousel title',
        entries: [
          {
            id: 'item1',
            formats: [{ format_id: '1', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a' }],
          },
          { id: 'item2', formats: [] },
        ],
      },
      context,
    );
    expect(info.extractorId).toBe('item1');
    expect(info.title).toBe('Carousel title');
  });

  it('refuses an empty playlist rather than returning a blank card', () => {
    expect(() => mapper.map({ _type: 'playlist', entries: [] }, context)).toThrow(EngineError);
  });

  it('reports an uninterpretable document as unsupported media', () => {
    let thrown: unknown;
    try {
      mapper.map('not an object', context);
    } catch (error: unknown) {
      thrown = error;
    }
    expect((thrown as EngineError).code).toBe(EngineFailureCode.UnsupportedMedia);
  });

  it('records whether cookies were used, so the result is not cached publicly', () => {
    const info = mapper.map(
      { id: 'a', title: 'x', formats: [] },
      { ...context, obtainedWithCookies: true },
    );
    expect(info.obtainedWithCookies).toBe(true);
  });

  it('picks the largest thumbnail when only the list is present', () => {
    const info = mapper.map(
      {
        id: 'a',
        title: 'x',
        formats: [],
        thumbnails: [
          { url: 'https://cdn.test/small.jpg', width: 100, height: 100 },
          { url: 'https://cdn.test/large.jpg', width: 1080, height: 1080 },
        ],
      },
      context,
    );
    expect(info.thumbnailUrl).toBe('https://cdn.test/large.jpg');
  });
});

describe('toIsoDate', () => {
  it('converts yt-dlp compact dates', () => {
    expect(toIsoDate('20260131')).toBe('2026-01-31');
  });

  it('drops anything that is not a compact date rather than guessing', () => {
    expect(toIsoDate('2026-01-31')).toBeUndefined();
    expect(toIsoDate('nonsense')).toBeUndefined();
    expect(toIsoDate(undefined)).toBeUndefined();
  });
});
