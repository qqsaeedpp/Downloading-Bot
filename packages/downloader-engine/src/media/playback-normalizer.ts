import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { DownloadStage } from '@tgtools/shared';
import type { Logger } from '@tgtools/shared';
import { describeError, formatBytes } from '@tgtools/shared';
import { runProcess } from '../process/run-process.js';
import type { Ffprobe, ProbedMedia } from './ffprobe.js';

/**
 * Codecs Telegram's mobile clients decode reliably. Anything else shows the
 * first frame and then freezes while the audio keeps playing — which is the
 * single most-reported bug in this class of bot, and the reason this module
 * exists.
 */
const SAFE_VIDEO_CODEC = 'h264';
const SAFE_AUDIO_CODECS = new Set(['aac', 'mp3']);

export interface NormalizerConfig {
  readonly ffmpegPath: string;
  readonly timeoutMs: number;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly preset: string;
  readonly crf: number;
  /** Above this size a bad codec is remuxed rather than re-encoded. */
  readonly maxTranscodeBytes: number;
  readonly logger: Logger;
}

export type NormalizationAction =
  'none' | 'remux' | 'transcode-video' | 'transcode-audio' | 'transcode-both';

export interface NormalizationPlan {
  readonly action: NormalizationAction;
  readonly reencodeVideo: boolean;
  readonly reencodeAudio: boolean;
  readonly reason: string;
}

export interface NormalizationResult {
  readonly filePath: string;
  readonly plan: NormalizationPlan;
  readonly probe: ProbedMedia | undefined;
}

/**
 * Decide what has to happen to a file before Telegram can play it.
 *
 * Pure, and separate from the running of it, because this is where the
 * judgement calls live: `--merge-output-format mp4` only ever sets the
 * CONTAINER, so an MP4 is not remotely the same thing as a playable file.
 */
export function planNormalization(
  probe: ProbedMedia | undefined,
  fileSizeBytes: number,
  maxTranscodeBytes: number,
): NormalizationPlan {
  if (probe?.videoCodec === undefined) {
    return {
      action: 'none',
      reencodeVideo: false,
      reencodeAudio: false,
      reason: 'not a video, or the probe failed — leave the file alone',
    };
  }

  let reencodeVideo = probe.videoCodec !== SAFE_VIDEO_CODEC;

  // Re-encoding is priced per pixel: a 2.5-minute 4K clip measures around nine
  // minutes on four cores. Past a point the cost outweighs the benefit — a file
  // that large is being watched on a desktop, where VP9 and AV1 play fine — so
  // above the threshold we only remux, which still fixes the moov position.
  let sizeCapped = false;
  if (reencodeVideo && fileSizeBytes > maxTranscodeBytes) {
    reencodeVideo = false;
    sizeCapped = true;
  }

  // 10-bit and 4:2:2 content is rejected by older hardware decoders even when
  // the codec itself is H.264, so the pixel format is part of the decision.
  const pixelFormatIsSafe =
    probe.pixelFormat === undefined ||
    probe.pixelFormat === 'yuv420p' ||
    probe.pixelFormat === 'yuvj420p';
  if (!reencodeVideo && !sizeCapped && !pixelFormatIsSafe) reencodeVideo = true;

  const reencodeAudio = probe.audioCodec !== undefined && !SAFE_AUDIO_CODECS.has(probe.audioCodec);

  if (!reencodeVideo && !reencodeAudio) {
    return {
      action: 'remux',
      reencodeVideo: false,
      reencodeAudio: false,
      // A single progressive download never runs the merger, so it never picked
      // up `+faststart` either: its moov atom sits at the end of the file and
      // players stall before they can start.
      reason: sizeCapped
        ? `codec is not ideal but the file exceeds the ${formatBytes(maxTranscodeBytes)} transcode ceiling; remuxing only`
        : 'codecs are already safe; remux to guarantee faststart',
    };
  }

  const action: NormalizationAction =
    reencodeVideo && reencodeAudio
      ? 'transcode-both'
      : reencodeVideo
        ? 'transcode-video'
        : 'transcode-audio';

  return {
    action,
    reencodeVideo,
    reencodeAudio,
    reason: `video=${probe.videoCodec} audio=${probe.audioCodec ?? 'none'} pix_fmt=${probe.pixelFormat ?? 'unknown'}`,
  };
}

export class PlaybackNormalizer {
  constructor(
    private readonly config: NormalizerConfig,
    private readonly ffprobe: Ffprobe,
  ) {}

  /**
   * Make the file play everywhere, especially on phones.
   *
   * Best-effort by design: on any ffmpeg failure the original is kept rather
   * than failing a download that would probably have played fine.
   */
  async normalize(
    filePath: string,
    options: {
      signal?: AbortSignal | undefined;
      onStageChange?: ((stage: DownloadStage) => void | Promise<void>) | undefined;
    } = {},
  ): Promise<NormalizationResult> {
    const probe = await this.ffprobe.probe(filePath, options.signal);
    const { size } = await stat(filePath);
    const plan = planNormalization(probe, size, this.config.maxTranscodeBytes);

    if (plan.action === 'none') return { filePath, plan, probe };

    if (plan.reencodeVideo || plan.reencodeAudio) {
      await options.onStageChange?.(DownloadStage.Normalizing);
    }

    const directory = dirname(filePath);
    const stem = basename(filePath, extname(filePath));
    const target = join(directory, `${stem}.mp4`);
    // Work through a scratch name and move it into place, so the user still
    // receives "<name>.mp4" rather than a working name leaking out.
    const scratch = join(directory, `${stem}.normalizing.mp4`);

    const args = [
      '-loglevel',
      'error',
      '-y',
      '-i',
      filePath,
      '-map',
      '0:v:0?',
      '-map',
      '0:a:0?',
      '-c:v',
      plan.reencodeVideo ? this.config.videoCodec : 'copy',
      ...(plan.reencodeVideo
        ? [
            '-preset',
            this.config.preset,
            '-crf',
            String(this.config.crf),
            // What old hardware decoders expect; a 10-bit VP9 source would
            // otherwise stay unplayable even after the codec change.
            '-pix_fmt',
            'yuv420p',
            // Odd dimensions are illegal in yuv420p and abort the encode.
            '-vf',
            'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          ]
        : []),
      '-c:a',
      plan.reencodeAudio ? this.config.audioCodec : 'copy',
      ...(plan.reencodeAudio ? ['-b:a', '128k'] : []),
      // Frame rate is left alone deliberately: changing it costs quality and
      // fixes nothing Telegram cares about.
      '-movflags',
      '+faststart',
      scratch,
    ];

    try {
      await runProcess({
        executable: this.config.ffmpegPath,
        args,
        timeoutMs: this.config.timeoutMs,
        signal: options.signal,
        label: 'ffmpeg-normalize',
        logger: this.config.logger,
      });
      await rm(filePath, { force: true });
      await rename(scratch, target);
      this.config.logger.debug('normalised media for playback', {
        action: plan.action,
        reason: plan.reason,
      });
      return { filePath: target, plan, probe: await this.ffprobe.probe(target, options.signal) };
    } catch (error: unknown) {
      await rm(scratch, { force: true }).catch(() => {
        // The scratch file may never have been created; nothing to report.
      });
      this.config.logger.warn('normalisation failed; delivering the original file', {
        action: plan.action,
        error: describeError(error),
      });
      return { filePath, plan, probe };
    }
  }

  async version(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { stdout } = await runProcess({
        executable: this.config.ffmpegPath,
        args: ['-version'],
        timeoutMs: 10_000,
        signal,
        label: 'ffmpeg-version',
        logger: this.config.logger,
      });
      return stdout.split(/\r?\n/)[0]?.trim();
    } catch {
      return undefined;
    }
  }
}
