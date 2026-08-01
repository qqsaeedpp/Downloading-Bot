import { describe, expect, it } from 'vitest';
import type { ProbedMedia } from './ffprobe.js';
import { parseFfprobeOutput } from './ffprobe.js';
import { planNormalization } from './playback-normalizer.js';

const MB = 1024 * 1024;

function probe(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    durationSeconds: 30,
    bitrateBps: 2_000_000,
    formatName: 'mov,mp4,m4a',
    pixelFormat: 'yuv420p',
    rotationDegrees: undefined,
    hasAlphaChannel: false,
    ...overrides,
  };
}

describe('planNormalization', () => {
  it('remuxes an already-safe file rather than leaving it alone', () => {
    const plan = planNormalization(probe(), 10 * MB, 250 * MB);
    // A single progressive download never runs yt-dlp's merger, so it never
    // picked up +faststart: its moov atom sits at the end and players stall
    // before they can start.
    expect(plan.action).toBe('remux');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.reencodeAudio).toBe(false);
  });

  it.each(['vp9', 'vp09', 'av01', 'hevc'])('re-encodes %s, which freezes on phones', (codec) => {
    const plan = planNormalization(probe({ videoCodec: codec }), 10 * MB, 250 * MB);
    expect(plan.reencodeVideo).toBe(true);
  });

  it('re-encodes audio that is neither AAC nor MP3', () => {
    const plan = planNormalization(probe({ audioCodec: 'opus' }), 10 * MB, 250 * MB);
    expect(plan.reencodeAudio).toBe(true);
    expect(plan.action).toBe('transcode-audio');
  });

  it('leaves MP3 audio alone', () => {
    expect(planNormalization(probe({ audioCodec: 'mp3' }), 10 * MB, 250 * MB).reencodeAudio).toBe(
      false,
    );
  });

  it('drops back to a remux for a large file with a bad codec', () => {
    // A 2.5-minute 4K re-encode measures around nine minutes on four cores. Past
    // a point the cost outweighs the benefit — a file that big is being watched
    // on a desktop, where VP9 plays fine.
    const plan = planNormalization(probe({ videoCodec: 'vp9' }), 400 * MB, 250 * MB);
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.action).toBe('remux');
    expect(plan.reason).toContain('transcode ceiling');
  });

  it('re-encodes a 10-bit file even when the codec itself is fine', () => {
    // Old hardware decoders reject yuv420p10le regardless of the codec name.
    const plan = planNormalization(probe({ pixelFormat: 'yuv420p10le' }), 10 * MB, 250 * MB);
    expect(plan.reencodeVideo).toBe(true);
  });

  it('does nothing when the file is not a video', () => {
    const plan = planNormalization(probe({ videoCodec: undefined }), 1 * MB, 250 * MB);
    expect(plan.action).toBe('none');
  });

  it('does nothing when the probe failed, rather than guessing', () => {
    const plan = planNormalization(undefined, 1 * MB, 250 * MB);
    expect(plan.action).toBe('none');
  });

  it('re-encodes both streams when both are wrong', () => {
    const plan = planNormalization(
      probe({ videoCodec: 'vp9', audioCodec: 'opus' }),
      10 * MB,
      250 * MB,
    );
    expect(plan.action).toBe('transcode-both');
  });
});

describe('parseFfprobeOutput', () => {
  it('reads codecs, dimensions and duration', () => {
    const parsed = parseFfprobeOutput(
      JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 720, height: 1280, pix_fmt: 'yuv420p' },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: { duration: '27.400000', bit_rate: '1500000', format_name: 'mov,mp4,m4a' },
      }),
    );

    expect(parsed?.videoCodec).toBe('h264');
    expect(parsed?.audioCodec).toBe('aac');
    expect(parsed?.width).toBe(720);
    expect(parsed?.durationSeconds).toBeCloseTo(27.4);
  });

  it('reads rotation from the modern display-matrix side data', () => {
    const parsed = parseFfprobeOutput(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', side_data_list: [{ rotation: -90 }] }],
        format: {},
      }),
    );
    // Reading only one of the two rotation sources is how a portrait video ends
    // up sideways.
    expect(parsed?.rotationDegrees).toBe(270);
  });

  it('reads rotation from the legacy tag', () => {
    const parsed = parseFfprobeOutput(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', tags: { rotate: '90' } }],
        format: {},
      }),
    );
    expect(parsed?.rotationDegrees).toBe(90);
  });

  it('flags a pixel format that carries transparency', () => {
    const parsed = parseFfprobeOutput(
      JSON.stringify({ streams: [{ codec_type: 'video', pix_fmt: 'rgba' }], format: {} }),
    );
    // Flattening alpha into JPEG turns transparency black, which ruins a
    // sticker-style pin.
    expect(parsed?.hasAlphaChannel).toBe(true);
  });

  it('returns undefined for output that is not JSON', () => {
    expect(parseFfprobeOutput('ffprobe: command not found')).toBeUndefined();
  });

  it('ignores a duration of zero rather than reporting it', () => {
    const parsed = parseFfprobeOutput(
      JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: '0' } }),
    );
    expect(parsed?.durationSeconds).toBeUndefined();
  });
});
