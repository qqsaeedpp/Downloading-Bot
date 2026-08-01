import { MediaKind } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import type { EngineMediaFormat } from '../engine-types.js';
import { YtDlpFormatSelector, hasExtractableAudio } from './format-selector.js';

function format(overrides: Partial<EngineMediaFormat> = {}): EngineMediaFormat {
  const videoCodec = 'videoCodec' in overrides ? overrides.videoCodec : undefined;
  const audioCodec = 'audioCodec' in overrides ? overrides.audioCodec : undefined;
  const hasVideo = videoCodec !== undefined && videoCodec !== 'none';
  const hasAudio = audioCodec !== undefined && audioCodec !== 'none';
  return {
    id: 'f1',
    ext: 'mp4',
    width: undefined,
    height: undefined,
    fps: undefined,
    videoCodec,
    audioCodec,
    filesizeBytes: undefined,
    totalBitrateKbps: undefined,
    audioBitrateKbps: undefined,
    protocol: 'https',
    formatNote: undefined,
    isProgressive: hasVideo && hasAudio,
    isVideoOnly: hasVideo && !hasAudio,
    isAudioOnly: !hasVideo && hasAudio,
    ...overrides,
  };
}

describe('hasExtractableAudio', () => {
  it('says no when the post has no formats at all', () => {
    // An image-only tweet. Offering "128 kbps" here is what sent users into a
    // download that yt-dlp could only answer with "No video could be found".
    expect(hasExtractableAudio([], MediaKind.Unknown)).toBe(false);
    expect(hasExtractableAudio([], MediaKind.Image)).toBe(false);
  });

  it('says no when every format explicitly declares no audio track', () => {
    // A tweeted GIF is a video with no audio stream. yt-dlp says so; believe it.
    const gif = [format({ videoCodec: 'h264', audioCodec: 'none' })];
    expect(hasExtractableAudio(gif, MediaKind.Video)).toBe(false);
  });

  it('says yes when a format declares a real audio codec', () => {
    expect(
      hasExtractableAudio([format({ videoCodec: 'h264', audioCodec: 'aac' })], MediaKind.Video),
    ).toBe(true);
  });

  it('says yes when a separate audio-only rendition exists', () => {
    const dash = [
      format({ videoCodec: 'vp9', audioCodec: 'none' }),
      format({ videoCodec: 'none', audioCodec: 'opus' }),
    ];
    expect(hasExtractableAudio(dash, MediaKind.Video)).toBe(true);
  });

  it('assumes audio on a video whose streams are simply undescribed', () => {
    // Instagram's pre-muxed file declares neither codec. It is a real video and
    // it does have sound; refusing an audio option there would be a regression.
    const unlabelled = [format({ ext: 'mp4' })];
    expect(hasExtractableAudio(unlabelled, MediaKind.Video)).toBe(true);
  });

  it('does not assume audio when the kind is unknown and nothing is described', () => {
    expect(hasExtractableAudio([format({ ext: 'jpg' })], MediaKind.Unknown)).toBe(false);
    expect(hasExtractableAudio([format({ ext: 'jpg' })], MediaKind.Image)).toBe(false);
  });
});

describe('YtDlpFormatSelector.listAudioOptions', () => {
  const selector = new YtDlpFormatSelector();

  it('offers nothing for a post with no audio evidence', () => {
    // The old implementation had a `ladder.length > 0 ? ladder : [128]` floor,
    // so it could never return an empty list — which is precisely how a photo
    // tweet ended up advertising two audio bitrates.
    expect(selector.listAudioOptions([], undefined, MediaKind.Unknown)).toEqual([]);
    expect(selector.listAudioOptions([], undefined, MediaKind.Image)).toEqual([]);
  });

  it('offers nothing for a silent video', () => {
    const gif = [format({ videoCodec: 'h264', audioCodec: 'none' })];
    expect(selector.listAudioOptions(gif, 5, MediaKind.Video)).toEqual([]);
  });

  it('still offers the ladder for a real video with sound', () => {
    const options = selector.listAudioOptions(
      [format({ videoCodec: 'h264', audioCodec: 'aac', audioBitrateKbps: 128 })],
      60,
      MediaKind.Video,
    );
    expect(options.map((option) => option.audioBitrateKbps)).toEqual([128]);
  });
});
