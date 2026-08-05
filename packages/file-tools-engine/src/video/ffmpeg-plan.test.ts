import { describe, expect, it } from 'vitest';
import { ToolErrorCode, isToolError } from '../errors/tool-error.js';
import type { VideoLimits, VideoMetadata } from './video-processor.js';
import {
  FfmpegProgressParser,
  assertUsableVideo,
  buildMp3Args,
  buildProbeArgs,
  buildRemoveAudioArgs,
  estimateMp3Bytes,
  mp3BitrateBps,
  parseFfprobeJson,
} from './ffmpeg-plan.js';

const LIMITS: VideoLimits = { maxInputBytes: 20 * 1024 * 1024, maxDurationSeconds: 7_200 };

function codeOf(error: unknown): string | undefined {
  return isToolError(error) ? error.code : undefined;
}

/** Realistic ffprobe output, trimmed to the fields the parser reads. */
const PROBE_WITH_AUDIO = JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, bit_rate: '128000' },
  ],
  format: { duration: '61.5', size: '5242880', bit_rate: '682000', format_name: 'mov,mp4,m4a' },
});

describe('parseFfprobeJson', () => {
  it('reads streams and format into one shape', () => {
    const meta = parseFfprobeJson(PROBE_WITH_AUDIO);

    expect(meta).toMatchObject({
      durationSeconds: 61.5,
      sizeBytes: 5_242_880,
      formatName: 'mov,mp4,m4a',
    });
    expect(meta?.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080 });
    expect(meta?.audio).toMatchObject({ codec: 'aac', channels: 2 });
  });

  it('reports a missing audio stream as absent, not as an empty object', () => {
    // The caller branches on `audio === undefined` to produce
    // VIDEO_HAS_NO_AUDIO. An empty object would silently pass that check.
    const meta = parseFfprobeJson(
      JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }], format: {} }),
    );
    expect(meta?.audio).toBeUndefined();
    expect(meta?.video).toBeDefined();
  });

  it('turns "N/A" into undefined rather than NaN', () => {
    // ffprobe writes N/A for anything it could not determine. A NaN duration
    // propagated into a size estimate produces a NaN ceiling that every
    // comparison silently passes.
    const meta = parseFfprobeJson(
      JSON.stringify({ streams: [], format: { duration: 'N/A', bit_rate: 'N/A' } }),
    );
    expect(meta?.durationSeconds).toBeUndefined();
    expect(meta?.bitrateBps).toBeUndefined();
  });

  it('returns undefined for output that is not JSON', () => {
    // That means ffprobe failed, and the caller's exit-code check gives a
    // better message than a parse error would.
    for (const bad of ['', 'ffprobe: command not found', '{', 'null']) {
      expect(() => parseFfprobeJson(bad)).not.toThrow();
    }
    expect(parseFfprobeJson('not json')).toBeUndefined();
  });

  it('takes the FIRST stream of each kind', () => {
    // A multi-language file has several audio tracks; taking track zero is a
    // deliberate choice rather than a guess at which language was wanted.
    const meta = parseFfprobeJson(
      JSON.stringify({
        streams: [
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'audio', codec_name: 'ac3' },
        ],
        format: {},
      }),
    );
    expect(meta?.audio?.codec).toBe('aac');
  });
});

describe('assertUsableVideo', () => {
  const base: VideoMetadata = {
    durationSeconds: 60,
    formatName: 'mp4',
    sizeBytes: 1_000,
    bitrateBps: 1_000,
    video: { codec: 'h264', width: 640, height: 480 },
    audio: { codec: 'aac', channels: 2, bitrateBps: 128_000 },
  };

  it('accepts an ordinary file', () => {
    expect(() => assertUsableVideo(base, LIMITS)).not.toThrow();
  });

  it('rejects a file with neither video nor audio', () => {
    expect(() =>
      assertUsableVideo({ ...base, video: undefined, audio: undefined }, LIMITS),
    ).toThrow();
  });

  it('rejects a video over the duration ceiling', () => {
    try {
      assertUsableVideo({ ...base, durationSeconds: 10_000 }, LIMITS);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.VideoTooLong);
    }
  });

  it('accepts a file whose duration is unknown rather than guessing', () => {
    // A stream copy works fine without a duration; refusing here would decline
    // legitimate files for missing metadata.
    expect(() => assertUsableVideo({ ...base, durationSeconds: undefined }, LIMITS)).not.toThrow();
  });
});

describe('MP3 size estimation', () => {
  it('maps each quality to its real bitrate', () => {
    expect(mp3BitrateBps('128')).toBe(128_000);
    expect(mp3BitrateBps('320')).toBe(320_000);
    // VBR at -q:a 2 averages about 190 kbps.
    expect(mp3BitrateBps('vbr')).toBe(190_000);
  });

  it('estimates from bitrate and duration', () => {
    // Three minutes at 128 kbps is about 2.9 MB.
    const bytes = estimateMp3Bytes(180, '128');
    expect(bytes).toBeGreaterThan(2.7 * 1024 * 1024);
    expect(bytes).toBeLessThan(3.1 * 1024 * 1024);
  });

  it('estimates high enough to refuse a borderline job before encoding it', () => {
    // Erring high is the safe direction: the cost is declining a job that might
    // just have fitted, against a user waiting through a full extraction to be
    // told the result cannot be sent.
    const oneHourAt320 = estimateMp3Bytes(3_600, '320');
    expect(oneHourAt320).toBeGreaterThan(130 * 1024 * 1024);
  });
});

describe('buildMp3Args', () => {
  it('selects the first audio track and excludes video', () => {
    // `-map 0:a:0` and `-vn` together. Either alone leaves a case where a cover
    // image rides along and turns a 4 MB MP3 into a 40 MB one.
    const args = buildMp3Args('in.mp4', 'out.mp3', { quality: '192' });
    expect(args).toContain('-vn');
    expect(args.join(' ')).toContain('-map 0:a:0');
  });

  it('uses a constant bitrate for a numeric quality', () => {
    expect(buildMp3Args('in.mp4', 'out.mp3', { quality: '320' }).join(' ')).toContain('-b:a 320k');
  });

  it('uses variable bitrate for vbr, not a bogus "-b:a vbrk"', () => {
    const args = buildMp3Args('in.mp4', 'out.mp3', { quality: 'vbr' }).join(' ');
    expect(args).toContain('-q:a 2');
    expect(args).not.toContain('vbrk');
  });

  it('always encodes with libmp3lame', () => {
    expect(buildMp3Args('in.mp4', 'out.mp3', { quality: '128' }).join(' ')).toContain(
      '-c:a libmp3lame',
    );
  });

  it('writes ID3v2.3, which more players actually read', () => {
    expect(buildMp3Args('in.mp4', 'out.mp3', { quality: '128' }).join(' ')).toContain(
      '-id3v2_version 3',
    );
  });

  it('requests machine-readable progress and no status line', () => {
    const args = buildMp3Args('in.mp4', 'out.mp3', { quality: '128' });
    expect(args.join(' ')).toContain('-progress pipe:1');
    expect(args).toContain('-nostats');
  });

  it('never blocks on stdin', () => {
    expect(buildMp3Args('in.mp4', 'out.mp3', { quality: '128' })).toContain('-nostdin');
  });

  it('passes paths as separate arguments, not interpolated into one', () => {
    // The runner uses an argument array; a path with a space must survive as
    // exactly one element.
    const args = buildMp3Args('/tmp/my video.mp4', '/tmp/out file.mp3', { quality: '128' });
    expect(args).toContain('/tmp/my video.mp4');
    expect(args).toContain('/tmp/out file.mp3');
  });
});

describe('buildRemoveAudioArgs', () => {
  it('copies the video stream instead of re-encoding it', () => {
    // The whole point: a two-hour film becomes a disk copy rather than a
    // two-hour re-encode, and loses no quality at all.
    const args = buildRemoveAudioArgs('in.mp4', 'out.mp4').join(' ');
    expect(args).toContain('-c:v copy');
    expect(args).not.toContain('libx264');
    expect(args).not.toContain('-crf');
  });

  it('drops audio and maps the video track explicitly', () => {
    const args = buildRemoveAudioArgs('in.mp4', 'out.mp4');
    expect(args).toContain('-an');
    expect(args.join(' ')).toContain('-map 0:v:0');
  });

  it('moves the index to the front so the result plays while downloading', () => {
    expect(buildRemoveAudioArgs('in.mp4', 'out.mp4').join(' ')).toContain('-movflags +faststart');
  });
});

describe('buildProbeArgs', () => {
  it('asks for JSON, streams and format', () => {
    const args = buildProbeArgs('in.mp4').join(' ');
    expect(args).toContain('-show_streams');
    expect(args).toContain('-show_format');
    expect(args).toContain('-of json');
  });
});

describe('FfmpegProgressParser', () => {
  it('converts out_time_us against the total duration', () => {
    const parser = new FfmpegProgressParser(100);
    expect(parser.push('out_time_us=50000000\n')).toBeCloseTo(0.5, 3);
  });

  it('accepts out_time_ms, which is also microseconds despite the name', () => {
    // An FFmpeg naming quirk. Reading it as milliseconds would report 0.05%
    // where the truth is 50%.
    const parser = new FfmpegProgressParser(100);
    expect(parser.push('out_time_ms=50000000\n')).toBeCloseTo(0.5, 3);
  });

  it('reassembles a line split across chunks', () => {
    // The stream arrives in arbitrary chunks; a naive parser drops or
    // mis-reads whatever straddles a boundary.
    const parser = new FfmpegProgressParser(100);
    expect(parser.push('out_time_us=25')).toBeUndefined();
    expect(parser.push('000000\n')).toBeCloseTo(0.25, 3);
  });

  it('never reports more than 100%', () => {
    // A container whose declared duration is short by a frame would otherwise
    // show 101%, which reads as a bug to the person watching.
    const parser = new FfmpegProgressParser(10);
    expect(parser.push('out_time_us=20000000\n')).toBe(1);
  });

  it('treats progress=end as completion whatever the timestamps said', () => {
    const parser = new FfmpegProgressParser(100);
    expect(parser.push('progress=end\n')).toBe(1);
  });

  it('ignores N/A, which FFmpeg emits before the first frame', () => {
    const parser = new FfmpegProgressParser(100);
    expect(parser.push('out_time_us=N/A\n')).toBeUndefined();
  });

  it('reports nothing when the duration is unknown', () => {
    // A fraction needs a denominator. Inventing one would show a bar that
    // moves at a rate unrelated to the work.
    const parser = new FfmpegProgressParser(undefined);
    expect(parser.push('out_time_us=5000000\n')).toBeUndefined();
  });

  it('ignores unrelated keys without breaking', () => {
    const parser = new FfmpegProgressParser(100);
    expect(parser.push('frame=120\nfps=30\nbitrate=1000kbits/s\n')).toBeUndefined();
    expect(parser.push('out_time_us=10000000\n')).toBeCloseTo(0.1, 3);
  });
});
