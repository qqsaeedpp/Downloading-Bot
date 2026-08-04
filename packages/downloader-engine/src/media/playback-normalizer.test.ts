import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DownloadStage } from '@tgtools/shared';
import { createNoopLogger } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import type { ProbedMedia } from './ffprobe.js';
import { parseFfprobeOutput } from './ffprobe.js';
import type { DeliveryPolicy, NormalizerConfig } from './playback-normalizer.js';
import { PlaybackNormalizer, planNormalization } from './playback-normalizer.js';

const MB = 1024 * 1024;

/** The MP4 family as ffprobe reports it: one comma-separated list, not a name. */
const MP4_CONTAINER = 'mov,mp4,m4a';
/** Likewise for Matroska, which is what a merged VP9/Opus download lands in. */
const MKV_CONTAINER = 'matroska,webm';

function probe(overrides: Partial<ProbedMedia> = {}): ProbedMedia {
  return {
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    durationSeconds: 30,
    bitrateBps: 2_000_000,
    formatName: MP4_CONTAINER,
    pixelFormat: 'yuv420p',
    rotationDegrees: undefined,
    hasAlphaChannel: false,
    ...overrides,
  };
}

function policy(overrides: Partial<DeliveryPolicy> = {}): DeliveryPolicy {
  return { maxTranscodeBytes: 250 * MB, fastDelivery: false, ...overrides };
}

/**
 * One test per row of the delivery matrix.
 *
 * The mode is what the sender switches on, but the two `reencode` flags are what
 * decide whether ffmpeg decodes a single frame — so both are asserted on every
 * row. A mode that silently started re-encoding would still deliver a playable
 * file, which is exactly why it would go unnoticed until someone measured the
 * wall clock.
 */
describe('planNormalization: the delivery matrix', () => {
  it('sends H.264/AAC already in MP4 untouched', () => {
    const plan = planNormalization(probe(), 10 * MB, policy());

    expect(plan.mode).toBe('direct-video');
    // The proof that no ffmpeg runs: a file that already plays is not worth a
    // full-length remux for the sake of a faster first frame.
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.reencodeAudio).toBe(false);
    expect(plan.transcodeSkippedReason).toBeUndefined();
  });

  it('remuxes H.264/AAC out of Matroska with a stream copy', () => {
    const plan = planNormalization(probe({ formatName: MKV_CONTAINER }), 10 * MB, policy());

    expect(plan.mode).toBe('remux-video');
    // Right streams, wrong box. Touching pixels here would cost minutes and
    // change nothing a player can see.
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.reencodeAudio).toBe(false);
  });

  it('re-encodes only the soundtrack of an H.264/Opus file', () => {
    const plan = planNormalization(
      probe({ audioCodec: 'opus', formatName: MKV_CONTAINER }),
      10 * MB,
      policy(),
    );

    expect(plan.mode).toBe('transcode-video');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.reencodeAudio).toBe(true);
    // Audio is not priced per pixel, so this case is never deferred to a
    // document the way an incompatible video codec is.
    expect(plan.transcodeSkippedReason).toBeUndefined();
  });

  it('ships a VP9 file over the transcode ceiling as a document', () => {
    const plan = planNormalization(probe({ videoCodec: 'vp9' }), 400 * MB, policy());

    expect(plan.mode).toBe('direct-document');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.transcodeSkippedReason).toContain('transcode ceiling');
  });

  it('ships a small 2160p AV1 file as a document because of its height alone', () => {
    // Small enough and compatibility was asked for, so only the resolution rule
    // can refuse this one — a 4K re-encode measures in minutes per clip.
    const plan = planNormalization(
      probe({ videoCodec: 'av01', height: 2160, width: 3840 }),
      10 * MB,
      policy({ fastDelivery: false }),
    );

    expect(plan.mode).toBe('direct-document');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.transcodeSkippedReason).toContain('too tall');
  });

  it('re-encodes a small VP9 file when compatibility was asked for', () => {
    const plan = planNormalization(
      probe({ videoCodec: 'vp9' }),
      10 * MB,
      policy({ fastDelivery: false }),
    );

    // The only row in the whole matrix that pays for a video re-encode.
    expect(plan.mode).toBe('transcode-video');
    expect(plan.reencodeVideo).toBe(true);
    expect(plan.transcodeSkippedReason).toBeUndefined();
  });

  it('ships the same small VP9 file as a document under fast delivery', () => {
    const plan = planNormalization(
      probe({ videoCodec: 'vp9' }),
      10 * MB,
      policy({ fastDelivery: true }),
    );

    // Same file, same ceilings, opposite answer: the operator asked for prompt
    // over perfect, and that preference outranks the re-encode.
    expect(plan.mode).toBe('direct-document');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.transcodeSkippedReason).toContain('VIDEO_FAST_DELIVERY');
  });

  it('refuses to call 10-bit H.264 in an MP4 directly playable', () => {
    // Old hardware decoders reject yuv420p10le regardless of the codec name, so
    // the pixel format is part of "is this safe" and not a detail of the codec
    // check. A rewrite that dropped this rule would look correct everywhere
    // except on the phones that report the bug.
    const plan = planNormalization(probe({ pixelFormat: 'yuv420p10le' }), 10 * MB, policy());

    expect(plan.mode).not.toBe('direct-video');
    expect(plan.mode).toBe('transcode-video');
    expect(plan.reencodeVideo).toBe(true);
  });

  it('leaves a file with no video stream alone', () => {
    // Audio downloads and images land here. There is no video decision to make,
    // and running ffmpeg over an MP3 to discover that is pure latency.
    const plan = planNormalization(probe({ videoCodec: undefined }), 1 * MB, policy());

    expect(plan.mode).toBe('direct-video');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.reencodeAudio).toBe(false);
  });

  it('leaves the file alone when the probe failed, rather than guessing', () => {
    const plan = planNormalization(undefined, 1 * MB, policy());

    expect(plan.mode).toBe('direct-video');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.reencodeAudio).toBe(false);
  });
});

describe('planNormalization: the rules behind the matrix', () => {
  it.each(['vp9', 'vp09', 'av01', 'hevc'])('re-encodes %s, which freezes on phones', (codec) => {
    const plan = planNormalization(probe({ videoCodec: codec }), 10 * MB, policy());
    expect(plan.mode).toBe('transcode-video');
    expect(plan.reencodeVideo).toBe(true);
  });

  it('re-encodes MP3 audio but copies the video', () => {
    // MP3 in MP4 is legal and most clients play it — but "most" is the problem.
    // The fix copies the video stream untouched and re-encodes only sound, so
    // it stays cheap even on a large file. A better trade than shipping
    // something that plays everywhere except on the device the user has.
    const plan = planNormalization(probe({ audioCodec: 'mp3' }), 10 * MB, policy());
    expect(plan.mode).toBe('transcode-video');
    expect(plan.reencodeAudio).toBe(true);
    // The expensive half must not happen: this is an audio fix, not a re-encode.
    expect(plan.reencodeVideo).toBe(false);
  });

  it('treats a file with no audio track as having safe audio', () => {
    const plan = planNormalization(probe({ audioCodec: undefined }), 10 * MB, policy());
    expect(plan.mode).toBe('direct-video');
    expect(plan.reencodeAudio).toBe(false);
  });

  it('re-encodes both streams when both are wrong', () => {
    const plan = planNormalization(
      probe({ videoCodec: 'vp9', audioCodec: 'opus', formatName: MKV_CONTAINER }),
      10 * MB,
      policy(),
    );

    expect(plan.mode).toBe('transcode-video');
    expect(plan.reencodeVideo).toBe(true);
    expect(plan.reencodeAudio).toBe(true);
  });

  it('reports every reason a re-encode was declined, not just the first', () => {
    // The delivery log is the only place an operator can see why a 4K download
    // arrived as a document; one reason out of three would send them tuning the
    // wrong ceiling.
    const plan = planNormalization(
      probe({ videoCodec: 'vp9', height: 2160 }),
      400 * MB,
      policy({ fastDelivery: true }),
    );

    expect(plan.mode).toBe('direct-document');
    expect(plan.transcodeSkippedReason).toContain('VIDEO_FAST_DELIVERY');
    expect(plan.transcodeSkippedReason).toContain('transcode ceiling');
    expect(plan.transcodeSkippedReason).toContain('too tall');
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

/**
 * The stage a user actually sees.
 *
 * `planNormalization` deciding correctly is not the same as the runner
 * announcing correctly, and the complaint that started this was about the
 * MESSAGE: a two-second delivery that said "optimising" read as a stall.
 *
 * Every case below lets ffmpeg fail — there is no binary here — because the
 * announcement happens before the process is spawned, which is exactly the
 * ordering being asserted.
 */
describe('PlaybackNormalizer stage announcements', () => {
  async function stagesFor(
    probed: Partial<ProbedMedia>,
    config: Partial<NormalizerConfig> = {},
  ): Promise<DownloadStage[]> {
    // A real file on disk: `normalize` stats it to size the delivery decision
    // before it plans anything, so a missing path fails ahead of the
    // announcement being tested.
    const directory = await mkdtemp(join(tmpdir(), 'tgtools-stage-'));
    const filePath = join(directory, 'clip.mkv');
    await writeFile(filePath, 'not really a video');

    const stages: DownloadStage[] = [];
    const normalizer = new PlaybackNormalizer(
      {
        ffmpegPath: 'ffmpeg-does-not-exist',
        timeoutMs: 1_000,
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'veryfast',
        crf: 23,
        maxTranscodeBytes: 80 * MB,
        fastDelivery: false,
        logger: createNoopLogger(),
        ...config,
      },
      { probe: () => Promise.resolve(probe(probed)) } as never,
    );

    try {
      await normalizer
        .normalize(filePath, {
          onStageChange: (stage: DownloadStage) => {
            stages.push(stage);
          },
        })
        .catch(() => undefined);
      return stages;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('announces nothing for a file that needs no ffmpeg', async () => {
    // Silence is the feature. Saying "optimising" about a file nobody is
    // optimising is how an instant delivery came to look like a stalled one.
    expect(await stagesFor({})).toEqual([]);
  });

  it('announces nothing for a file being handed over as a document', async () => {
    expect(await stagesFor({ videoCodec: 'av01', height: 2160 })).toEqual([]);
  });

  it('announces packaging, not optimising, for a stream copy', async () => {
    const stages = await stagesFor({ formatName: MKV_CONTAINER });
    expect(stages).toEqual(['packaging']);
    expect(stages).not.toContain('normalizing');
  });

  it('announces optimising only when pixels are actually re-encoded', async () => {
    const stages = await stagesFor({ videoCodec: 'vp9' }, { fastDelivery: false });
    expect(stages).toEqual(['normalizing']);
  });
});

/**
 * The ceilings that decline a re-encode, each on its own.
 *
 * These were the rows most likely to be lost in a refactor: every one of them
 * ends at `direct-document`, so a bug that collapsed them together would still
 * produce the right MODE and only the wrong REASON — and the reason is what an
 * operator reads when deciding whether to raise a limit.
 */
describe('planNormalization: why a re-encode was declined', () => {
  it('refuses a large AV1 file on size, not just on height', () => {
    // 1080p, so the height rule cannot be what catches it. Without this case an
    // AV1-over-the-ceiling bug would hide behind the 2160p test.
    const plan = planNormalization(
      probe({ videoCodec: 'av01', height: 1080, width: 1920 }),
      400 * MB,
      policy({ maxTranscodeBytes: 80 * MB, fastDelivery: false }),
    );

    expect(plan.mode).toBe('direct-document');
    expect(plan.reencodeVideo).toBe(false);
    expect(plan.transcodeSkippedReason).toContain('transcode ceiling');
    expect(plan.transcodeSkippedReason).not.toContain('too tall');
  });

  it('refuses a re-encode whose output could not be uploaded anyway', () => {
    // Spending minutes of CPU to produce a file the transport will reject is
    // strictly worse than sending the original as a document immediately.
    const plan = planNormalization(
      probe({ videoCodec: 'vp9', height: 1080 }),
      1_800 * MB,
      policy({ maxTranscodeBytes: 4_000 * MB, fastDelivery: false, maxUploadBytes: 50 * MB }),
    );

    expect(plan.mode).toBe('direct-document');
    expect(plan.transcodeSkippedReason).toContain('upload ceiling');
  });

  it('reports every reason at once, not just the first', () => {
    const plan = planNormalization(
      probe({ videoCodec: 'av01', height: 2160, width: 3840 }),
      900 * MB,
      policy({ maxTranscodeBytes: 80 * MB, fastDelivery: true }),
    );

    const reason = plan.transcodeSkippedReason ?? '';
    expect(reason).toContain('VIDEO_FAST_DELIVERY');
    expect(reason).toContain('transcode ceiling');
    expect(reason).toContain('too tall');
  });

  it('does not invent an upload objection when no ceiling was given', () => {
    // The engine knows nothing about Telegram. A caller with no transport limit
    // must not have one assumed for it.
    const plan = planNormalization(
      probe({ videoCodec: 'vp9', height: 1080 }),
      10 * MB,
      policy({ maxTranscodeBytes: 80 * MB, fastDelivery: false }),
    );

    expect(plan.mode).toBe('transcode-video');
    expect(plan.transcodeSkippedReason).toBeUndefined();
  });
});
