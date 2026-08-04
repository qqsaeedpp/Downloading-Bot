import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { DownloadStage } from '@tgtools/shared';
import type { VideoDeliveryMode } from '@tgtools/shared';
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
/**
 * AAC only.
 *
 * MP3 inside MP4 is legal and most clients cope, but "most" is the problem: the
 * pass that fixes it copies the video stream untouched and only re-encodes
 * sound, which is cheap and bounded even on a 1.5 GB file. Paying that to
 * guarantee playback is a better trade than shipping something that plays
 * everywhere except on the one device the user has.
 */
const SAFE_AUDIO_CODECS = new Set(['aac']);

export interface NormalizerConfig {
  readonly ffmpegPath: string;
  readonly timeoutMs: number;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly preset: string;
  readonly crf: number;
  /** Above this size a bad codec ships as-is rather than being re-encoded. */
  readonly maxTranscodeBytes: number;
  /** See {@link DeliveryPolicy.fastDelivery}. */
  readonly fastDelivery: boolean;
  /** See {@link DeliveryPolicy.maxUploadBytes}. */
  readonly maxUploadBytes?: number | undefined;
  readonly logger: Logger;
}

export interface NormalizationPlan {
  readonly mode: VideoDeliveryMode;
  readonly reencodeVideo: boolean;
  readonly reencodeAudio: boolean;
  readonly reason: string;
  /** Why a re-encode was declined, when one was. For the delivery log. */
  readonly transcodeSkippedReason: string | undefined;
}

/**
 * Containers Telegram accepts without repackaging.
 *
 * ffprobe reports the MP4 family as one comma-separated list —
 * `mov,mp4,m4a,3gp,3g2,mj2` — so this is a substring test rather than equality.
 */
const DELIVERABLE_CONTAINERS = ['mp4', 'mov'];

function containerIsDeliverable(formatName: string | undefined): boolean {
  if (formatName === undefined) return false;
  const parts = formatName.toLowerCase().split(',');
  return parts.some((part) => DELIVERABLE_CONTAINERS.includes(part.trim()));
}

/**
 * Resolutions where a re-encode stops being worth its wall-clock cost.
 *
 * Not a quality judgement: a 4K re-encode measures in minutes per clip, and the
 * person waiting would rather have the original now.
 */
const HEAVY_HEIGHT = 1440;

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
export interface DeliveryPolicy {
  /** Above this, an incompatible codec ships as-is rather than being re-encoded. */
  readonly maxTranscodeBytes: number;
  /**
   * Prefer arriving promptly over arriving perfect.
   *
   * With this on, an incompatible codec is never re-encoded: the original goes
   * out as a document immediately. Off, the size and resolution ceilings still
   * apply — they are absolute, not preferences.
   */
  readonly fastDelivery: boolean;
  /**
   * The ceiling the finished file has to fit under to be sendable at all.
   *
   * Checked here because a re-encode that cannot possibly be delivered is worse
   * than no re-encode: it costs minutes of CPU and then fails at the upload,
   * where the original would at least have arrived as a document.
   *
   * Optional so a caller that genuinely has no ceiling can omit it.
   */
  readonly maxUploadBytes?: number | undefined;
}

/**
 * A rough floor for what a re-encode will produce.
 *
 * H.264 at CRF 23 lands well under half the size of the VP9/AV1 source it
 * replaces in the common case, but "well under" is not a guarantee, and the
 * only cheap protection against spending nine minutes on an undeliverable file
 * is to refuse when even a generous estimate does not fit.
 */
const TRANSCODE_SIZE_RATIO = 0.6;

export function planNormalization(
  probe: ProbedMedia | undefined,
  fileSizeBytes: number,
  policy: DeliveryPolicy,
): NormalizationPlan {
  const nothingToDo = (reason: string): NormalizationPlan => ({
    mode: 'direct-video',
    reencodeVideo: false,
    reencodeAudio: false,
    reason,
    transcodeSkippedReason: undefined,
  });

  // Audio-only downloads and images land here, as does a probe that failed. In
  // every case there is no video decision to make.
  if (probe?.videoCodec === undefined) {
    return nothingToDo('not a video, or the probe failed — leave the file alone');
  }

  // 10-bit and 4:2:2 content is rejected by older hardware decoders even when
  // the codec itself is H.264, so the pixel format is part of "is this safe".
  const pixelFormatIsSafe =
    probe.pixelFormat === undefined ||
    probe.pixelFormat === 'yuv420p' ||
    probe.pixelFormat === 'yuvj420p';
  const videoIsSafe = probe.videoCodec === SAFE_VIDEO_CODEC && pixelFormatIsSafe;
  const audioIsSafe = probe.audioCodec === undefined || SAFE_AUDIO_CODECS.has(probe.audioCodec);

  if (videoIsSafe && audioIsSafe) {
    // MODE 1. Nothing to gain from ffmpeg, so it is not run.
    //
    // The cost of that choice, stated plainly: a progressive download never ran
    // the merger and so never got `+faststart`, leaving its moov atom at the end
    // of the file. A player may therefore buffer further before starting. That
    // is a slower FIRST FRAME, once — against a remux of the whole file, every
    // time, for a file that already plays. Delivery speed wins.
    if (containerIsDeliverable(probe.formatName)) {
      return nothingToDo('H.264/AAC already in an MP4 container — sent untouched');
    }

    // MODE 2. Right streams, wrong box. Copy them across; decode nothing.
    return {
      mode: 'remux-video',
      reencodeVideo: false,
      reencodeAudio: false,
      reason: `H.264/AAC in ${probe.formatName ?? 'an unknown container'} — stream copy to MP4`,
      transcodeSkippedReason: undefined,
    };
  }

  // A bad soundtrack on good video is cheap to fix — audio is not priced per
  // pixel — so it is never deferred to a document. The video is still copied.
  if (videoIsSafe && !audioIsSafe) {
    return {
      mode: 'transcode-video',
      reencodeVideo: false,
      reencodeAudio: true,
      reason: `audio is ${probe.audioCodec ?? 'unknown'}; re-encoding sound only, video copied`,
      transcodeSkippedReason: undefined,
    };
  }

  // MODE 3 vs 4. The video itself needs re-encoding, which is the expensive one:
  // a 2.5-minute 4K clip measures around nine minutes on four cores. Each of
  // these says "not worth it" for a different reason, and all are reported.
  const skip: string[] = [];
  if (policy.fastDelivery) skip.push('VIDEO_FAST_DELIVERY is on');
  if (fileSizeBytes > policy.maxTranscodeBytes) {
    skip.push(
      `file is ${formatBytes(fileSizeBytes)}, over the ` +
        `${formatBytes(policy.maxTranscodeBytes)} transcode ceiling`,
    );
  }
  if (probe.height !== undefined && probe.height >= HEAVY_HEIGHT) {
    skip.push(`${String(probe.height)}p is too tall to re-encode within a sensible wait`);
  }
  if (
    policy.maxUploadBytes !== undefined &&
    fileSizeBytes * TRANSCODE_SIZE_RATIO > policy.maxUploadBytes
  ) {
    skip.push(
      `even a re-encode would likely exceed the ${formatBytes(policy.maxUploadBytes)} upload ceiling`,
    );
  }

  if (skip.length > 0) {
    return {
      mode: 'direct-document',
      reencodeVideo: false,
      reencodeAudio: false,
      reason: `${probe.videoCodec} cannot stream in Telegram; delivering the original as a file`,
      transcodeSkippedReason: skip.join('; '),
    };
  }

  // MODE 4. Small enough, short enough, and the operator asked for compatibility
  // over speed.
  return {
    mode: 'transcode-video',
    reencodeVideo: true,
    reencodeAudio: !audioIsSafe,
    reason: `video=${probe.videoCodec} audio=${probe.audioCodec ?? 'none'} pix_fmt=${probe.pixelFormat ?? 'unknown'}`,
    transcodeSkippedReason: undefined,
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
    const plan = planNormalization(probe, size, {
      maxTranscodeBytes: this.config.maxTranscodeBytes,
      fastDelivery: this.config.fastDelivery,
      maxUploadBytes: this.config.maxUploadBytes,
    });

    // Both direct modes are defined by running no ffmpeg at all, so they leave
    // here before a single stage is announced. That silence is the feature: the
    // file is ready, and saying "optimising" about a file nobody is optimising
    // is how a two-second delivery came to look like a stalled one.
    if (plan.mode === 'direct-video' || plan.mode === 'direct-document') {
      return { filePath, plan, probe };
    }

    // A re-encode can run for minutes and a stream copy for seconds. Naming them
    // differently is the whole reason `Packaging` exists.
    await options.onStageChange?.(
      plan.reencodeVideo || plan.reencodeAudio
        ? DownloadStage.Normalizing
        : DownloadStage.Packaging,
    );

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
      // The video map is mandatory, the audio map optional. A file that reached
      // this path has a video stream by definition, so a missing one means the
      // input is not what the probe said — better to fail here, loudly, than to
      // emit a silent audio-only "video".
      '-map',
      '0:v:0',
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
        deliveryMode: plan.mode,
        reason: plan.reason,
      });
      return { filePath: target, plan, probe: await this.ffprobe.probe(target, options.signal) };
    } catch (error: unknown) {
      await rm(scratch, { force: true }).catch(() => {
        // The scratch file may never have been created; nothing to report.
      });
      this.config.logger.warn('normalisation failed; delivering the original file', {
        deliveryMode: plan.mode,
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
