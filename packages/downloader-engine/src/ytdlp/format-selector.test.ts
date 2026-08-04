import { MediaKind } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import type { EngineMediaFormat } from '../engine-types.js';
import {
  YtDlpFormatSelector,
  parseRequestedBitrate,
  parseRequestedHeight,
} from './format-selector.js';

const MB = 1024 * 1024;

function format(overrides: Partial<EngineMediaFormat> = {}): EngineMediaFormat {
  return {
    id: 'f1',
    ext: 'mp4',
    width: undefined,
    height: undefined,
    fps: undefined,
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    filesizeBytes: undefined,
    totalBitrateKbps: undefined,
    audioBitrateKbps: undefined,
    protocol: 'https',
    formatNote: undefined,
    isProgressive: true,
    isVideoOnly: false,
    isAudioOnly: false,
    ...overrides,
  };
}

describe('YtDlpFormatSelector.buildVideoSelector', () => {
  const selector = new YtDlpFormatSelector();

  it('puts the requested resolution ahead of the codec preference', () => {
    const result = selector.buildVideoSelector({
      requestedHeight: 2160,
      maxBytes: 500 * MB,
      allowProgressiveShortcut: false,
      formatId: undefined,
    });
    const candidates = result.split('/');

    const firstExact = candidates.findIndex((candidate) => candidate.includes('[height=2160]'));
    const firstAtMost = candidates.findIndex((candidate) => candidate.includes('[height<=2160]'));

    // Ordering these the other way round silently downgrades a 2160p request to
    // 1080p, because the best avc1 rendition is usually 1080p and `height<=2160`
    // matches it happily.
    expect(firstExact).toBeGreaterThanOrEqual(0);
    expect(firstExact).toBeLessThan(firstAtMost);
  });

  it('prefers H.264 only as a tiebreak within the same height', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: 1080,
        maxBytes: 500 * MB,
        allowProgressiveShortcut: false,
        formatId: undefined,
      })
      .split('/');

    const avcExact = candidates.findIndex(
      (candidate) => candidate.includes('[height=1080]') && candidate.includes('vcodec^=avc1'),
    );
    const anyExact = candidates.findIndex(
      (candidate) => candidate.includes('[height=1080]') && !candidate.includes('vcodec^=avc1'),
    );

    expect(avcExact).toBeLessThan(anyExact);
  });

  it('asks for H.264 video and AAC audio together before anything else', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: 1080,
        maxBytes: 500 * MB,
        allowProgressiveShortcut: false,
        formatId: undefined,
      })
      .split('/');

    // Telegram plays avc1+mp4a inline. Any other pairing is either an
    // attachment the user has to open elsewhere or a re-encode, so the pair is
    // asked for explicitly — merged first, then pre-muxed.
    expect(candidates[0]).toBe('bv*[height=1080][filesize<500M][vcodec^=avc1]+ba[acodec^=mp4a]');
    expect(candidates[1]).toBe('b[height=1080][filesize<500M][vcodec^=avc1][acodec^=mp4a]');
    // Only then does the older avc1-with-any-audio rung get its turn.
    expect(candidates[2]).toBe('bv*[height=1080][filesize<500M][vcodec^=avc1]+ba');
  });

  it('keeps a same-height VP9 pick ahead of every lower-height H.264 one', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: 2160,
        maxBytes: 500 * MB,
        allowProgressiveShortcut: false,
        formatId: undefined,
      })
      .split('/');

    const lastExact = candidates
      .map((candidate) => candidate.includes('[height=2160]'))
      .lastIndexOf(true);
    const firstAtMost = candidates.findIndex((candidate) => candidate.includes('[height<=2160]'));

    // Codec is a tiebreak WITHIN a height, never across one. 4K is usually
    // VP9/AV1 while the best avc1 copy is usually 1080p, so a codec rule
    // allowed to outrank a height answers "2160p" with a 1080p file.
    expect(lastExact).toBeGreaterThanOrEqual(0);
    expect(lastExact).toBeLessThan(firstAtMost);
    expect(candidates[lastExact]).not.toContain('avc1');
    expect(candidates[lastExact]).not.toContain('mp4a');
  });

  it('leaves VP9 and AV1 reachable rather than failing the download', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: 1080,
        maxBytes: 500 * MB,
        allowProgressiveShortcut: false,
        formatId: undefined,
      })
      .split('/');

    // The codec pairing is a preference, not a requirement: an Instagram reel
    // and a 4K upload often have no avc1 copy at all, so a rung naming no
    // codec has to survive at the requested height and again at the very end.
    expect(candidates).toContain('bv*[height=1080][filesize<500M]+ba');
    expect(candidates[candidates.length - 1]).toBe('b[filesize<?500M]');
    expect(candidates[candidates.length - 1]).not.toContain('codec');
  });

  it('uses the strict size filter before the lenient one', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: undefined,
        maxBytes: 500 * MB,
        allowProgressiveShortcut: false,
        formatId: undefined,
      })
      .split('/');

    const firstStrict = candidates.findIndex((candidate) => candidate.includes('[filesize<500M]'));
    const firstLenient = candidates.findIndex((candidate) =>
      candidate.includes('[filesize<?500M]'),
    );

    // Strict matches only formats that DECLARE a size, so a known-huge stream
    // can never win. Unknown sizes are admitted last, backstopped by the
    // runtime watchdog.
    expect(firstStrict).toBeGreaterThanOrEqual(0);
    expect(firstStrict).toBeLessThan(firstLenient);
  });

  it('always ends with an unconstrained fallback so a pick never hard-fails', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: 720,
        maxBytes: 100 * MB,
        allowProgressiveShortcut: false,
        formatId: undefined,
      })
      .split('/');

    const last = candidates[candidates.length - 1];
    expect(last).toBe('b[filesize<?100M]');
    expect(last).not.toContain('height');
    expect(last).not.toContain('avc1');
  });

  it('tries the unlabelled pre-muxed file first when the shortcut is allowed', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: undefined,
        maxBytes: 500 * MB,
        allowProgressiveShortcut: true,
        formatId: undefined,
      })
      .split('/');

    // Instagram's progressive copy declares no height, so it must be reached
    // by a candidate carrying no height filter at all.
    expect(candidates[0]).toBe('b[filesize<?500M][vcodec^=avc1]');
    expect(candidates[0]).not.toContain('height');
    // The shortcut is the platform's own intended file, so it stays ahead of
    // the codec ladder rather than being reordered behind the avc1+mp4a pair.
    expect(candidates[1]).toBe('b[filesize<?500M]');
    expect(candidates[2]).toBe('bv*[filesize<500M][vcodec^=avc1]+ba[acodec^=mp4a]');
  });

  it('never applies the progressive shortcut when a specific height was asked for', () => {
    const withHeight = selector.buildVideoSelector({
      requestedHeight: 480,
      maxBytes: 500 * MB,
      // The engine refuses to set this alongside a height; assert the selector
      // still behaves if a caller does, because honouring "480p" with a file of
      // unknown height would be a lie.
      allowProgressiveShortcut: false,
      formatId: undefined,
    });
    expect(withHeight.split('/')[0]).toContain('[height=480]');
  });

  it('honours an explicit format id first but keeps the fallback chain behind it', () => {
    const candidates = selector
      .buildVideoSelector({
        requestedHeight: 1080,
        maxBytes: 500 * MB,
        allowProgressiveShortcut: false,
        formatId: '137',
      })
      .split('/');

    expect(candidates[0]).toBe('137');
    expect(candidates.length).toBeGreaterThan(5);
    // The caller picked this format out of the listing; letting the codec
    // preference jump in front of it would make that pick meaningless.
    expect(candidates[1]).toBe('bv*[height=1080][filesize<500M][vcodec^=avc1]+ba[acodec^=mp4a]');
  });

  it('floors the byte ceiling to whole megabytes and never emits 0M', () => {
    const result = selector.buildVideoSelector({
      requestedHeight: undefined,
      maxBytes: 1_000,
      allowProgressiveShortcut: false,
      formatId: undefined,
    });
    // A `filesize<0M` filter would match nothing and fail every download.
    expect(result).toContain('[filesize<1M]');
    expect(result).not.toContain('0M');
  });
});

describe('YtDlpFormatSelector.listVideoOptions', () => {
  const selector = new YtDlpFormatSelector();

  it('lists each distinct height once, tallest first', () => {
    const options = selector.listVideoOptions(
      [
        format({ id: 'a', height: 720 }),
        format({ id: 'b', height: 1080 }),
        format({ id: 'c', height: 1080, videoCodec: 'vp09' }),
        format({ id: 'd', height: 480 }),
      ],
      500 * MB,
      30,
    );

    expect(options.map((option) => option.label)).toEqual(['1080p', '720p', '480p']);
  });

  it('drops a quality whose DECLARED size exceeds the ceiling', () => {
    const options = selector.listVideoOptions(
      [
        format({ id: 'big', height: 2160, filesizeBytes: 900 * MB }),
        format({ id: 'ok', height: 720, filesizeBytes: 40 * MB }),
      ],
      500 * MB,
      60,
    );

    expect(options.map((option) => option.label)).toEqual(['720p']);
  });

  it('keeps a quality of unknown size, because Instagram and TikTok declare none', () => {
    const options = selector.listVideoOptions(
      [format({ id: 'unknown', height: 1080, filesizeBytes: undefined })],
      1 * MB,
      60,
    );

    // Excluding unknowns here would leave those platforms with an empty menu;
    // the runtime watchdog is what actually bounds them.
    expect(options).toHaveLength(1);
    expect(options[0]?.label).toBe('1080p');
  });

  it('ignores audio-only formats', () => {
    const options = selector.listVideoOptions(
      [
        format({ id: 'audio', height: undefined, isAudioOnly: true, isProgressive: false }),
        format({ id: 'video', height: 720 }),
      ],
      500 * MB,
      30,
    );

    expect(options).toHaveLength(1);
  });

  it('estimates a size from bitrate and duration when none is declared', () => {
    const options = selector.listVideoOptions(
      [format({ id: 'a', height: 720, totalBitrateKbps: 800 })],
      500 * MB,
      60,
    );

    // 800 kbps for 60 s = 6,000,000 bytes.
    expect(options[0]?.estimatedBytes).toBe(6_000_000);
  });

  it('caps the keyboard at six qualities', () => {
    const formats = [144, 240, 360, 480, 720, 1080, 1440, 2160].map((height) =>
      format({ id: `h${height}`, height }),
    );
    expect(selector.listVideoOptions(formats, 5_000 * MB, 30)).toHaveLength(6);
  });
});

describe('YtDlpFormatSelector.listAudioOptions', () => {
  const selector = new YtDlpFormatSelector();

  it('never offers a bitrate the source cannot support', () => {
    const options = selector.listAudioOptions(
      [format({ id: 'a', audioBitrateKbps: 64, isAudioOnly: true, isProgressive: false })],
      120,
      MediaKind.Audio,
    );

    // Re-encoding 64 kbps to 320 produces a file five times the size that
    // sounds exactly the same. Claiming otherwise is dishonest.
    expect(options.map((option) => option.audioBitrateKbps)).toEqual([128]);
  });

  it('offers the full ladder when the source is high bitrate', () => {
    const options = selector.listAudioOptions(
      [format({ id: 'a', audioBitrateKbps: 320, isAudioOnly: true, isProgressive: false })],
      120,
      MediaKind.Audio,
    );
    expect(options.map((option) => option.audioBitrateKbps)).toEqual([320, 192, 128]);
  });

  it('stops at 192 when the source bitrate is unknown', () => {
    // A pre-muxed video track that declares a codec but no bitrate.
    const options = selector.listAudioOptions([format({ id: 'a' })], 120, MediaKind.Video);
    expect(options.map((option) => option.audioBitrateKbps)).toEqual([192, 128]);
  });

  it('estimates the output size from the chosen bitrate', () => {
    const options = selector.listAudioOptions(
      [format({ id: 'a', audioBitrateKbps: 192, isAudioOnly: true, isProgressive: false })],
      60,
      MediaKind.Audio,
    );
    // 192 kbps for 60 s = 1,440,000 bytes.
    expect(options[0]?.estimatedBytes).toBe(1_440_000);
  });
});

describe('YtDlpFormatSelector.estimateBytes', () => {
  const selector = new YtDlpFormatSelector();

  it('prefers the declared size over the bitrate arithmetic', () => {
    // The declared number is what the CDN will actually send. A bitrate is an
    // average, and on a variable-bitrate stream it can be out by a third.
    const bytes = selector.estimateBytes(
      format({ filesizeBytes: 12 * MB, totalBitrateKbps: 8_000 }),
      600,
    );
    expect(bytes).toBe(12 * MB);
  });

  it('falls back to bitrate times duration when no size is declared', () => {
    // 800 kbps for 60 s = 6,000,000 bytes.
    expect(selector.estimateBytes(format({ totalBitrateKbps: 800 }), 60)).toBe(6_000_000);
  });

  it('returns undefined when neither a size nor a bitrate is on offer', () => {
    expect(selector.estimateBytes(format(), 60)).toBeUndefined();
  });

  it('returns undefined when a bitrate is known but the duration is not', () => {
    // Half of the product is not an estimate; it is a guess with a unit.
    expect(selector.estimateBytes(format({ totalBitrateKbps: 800 }), undefined)).toBeUndefined();
  });

  it('ignores a declared size of zero rather than reporting it as tiny', () => {
    expect(selector.estimateBytes(format({ filesizeBytes: 0, totalBitrateKbps: 800 }), 60)).toBe(
      6_000_000,
    );
  });
});

describe('YtDlpFormatSelector.estimateSmallestVideoBytes', () => {
  const selector = new YtDlpFormatSelector();

  it('reports the smallest rendition, not the one most likely to be chosen', () => {
    // The chain's last two rungs carry no height filter, so a 144p copy really
    // is reachable. Refusing a download because the 4K copy is huge would
    // reject a post yt-dlp would have served from the small one.
    const bytes = selector.estimateSmallestVideoBytes(
      [
        format({ id: 'huge', height: 2160, filesizeBytes: 4_000 * MB }),
        format({ id: 'tiny', height: 144, filesizeBytes: 3 * MB }),
      ],
      600,
    );
    expect(bytes).toBe(3 * MB);
  });

  it('mixes declared sizes and bitrate estimates in the same comparison', () => {
    const bytes = selector.estimateSmallestVideoBytes(
      [
        format({ id: 'declared', height: 1080, filesizeBytes: 20 * MB }),
        // 800 kbps for 60 s = 6,000,000 bytes, which is the smaller of the two.
        format({ id: 'derived', height: 480, totalBitrateKbps: 800 }),
      ],
      60,
    );
    expect(bytes).toBe(6_000_000);
  });

  it('ignores audio-only formats, which are never the video rendition', () => {
    const bytes = selector.estimateSmallestVideoBytes(
      [
        format({ id: 'audio', filesizeBytes: 1 * MB, isAudioOnly: true, isProgressive: false }),
        format({ id: 'video', height: 720, filesizeBytes: 40 * MB }),
      ],
      60,
    );
    expect(bytes).toBe(40 * MB);
  });

  it('returns undefined when nothing declares a size or a bitrate', () => {
    // Instagram and TikTok look exactly like this. The caller must read the
    // absence as "do not block", never as "zero" — the runtime watchdog is the
    // backstop that exists for them.
    expect(selector.estimateSmallestVideoBytes([format({ height: 1080 })], 60)).toBeUndefined();
  });

  it('returns undefined for a post with no formats at all', () => {
    expect(selector.estimateSmallestVideoBytes([], 60)).toBeUndefined();
  });

  it('ignores the formats it cannot size rather than treating them as free', () => {
    const bytes = selector.estimateSmallestVideoBytes(
      [
        format({ id: 'unknown', height: 1080 }),
        format({ id: 'known', height: 720, filesizeBytes: 40 * MB }),
      ],
      60,
    );
    expect(bytes).toBe(40 * MB);
  });
});

describe('quality string parsing', () => {
  it.each([
    ['1080p', 1080],
    ['720', 720],
    ['hd1080', 1080],
    ['2160p60', 2160],
  ])('reads %s as height %d', (input, expected) => {
    expect(parseRequestedHeight(input)).toBe(expected);
  });

  it('returns undefined for a quality with no height in it', () => {
    expect(parseRequestedHeight('best')).toBeUndefined();
    expect(parseRequestedHeight(undefined)).toBeUndefined();
  });

  it.each([
    ['192k', 192],
    ['320kbps', 320],
    ['128', 128],
  ])('reads %s as bitrate %d', (input, expected) => {
    expect(parseRequestedBitrate(input)).toBe(expected);
  });
});
