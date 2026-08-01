import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import { runProcess } from '../process/run-process.js';

export interface ProbedStream {
  readonly codecType: string | undefined;
  readonly codecName: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly pixelFormat: string | undefined;
  readonly rotation: number | undefined;
}

export interface ProbedMedia {
  readonly videoCodec: string | undefined;
  readonly audioCodec: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly durationSeconds: number | undefined;
  readonly bitrateBps: number | undefined;
  readonly formatName: string | undefined;
  readonly pixelFormat: string | undefined;
  /** Degrees the player must rotate. 90/270 mean width and height are swapped. */
  readonly rotationDegrees: number | undefined;
  readonly hasAlphaChannel: boolean;
}

export interface FfprobeOptions {
  readonly ffprobePath: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

/** Pixel formats that carry transparency; JPEG cannot represent them. */
const ALPHA_PIXEL_FORMATS = new Set([
  'yuva420p',
  'yuva422p',
  'yuva444p',
  'rgba',
  'bgra',
  'argb',
  'abgr',
  'ya8',
  'ya16le',
  'ya16be',
  'rgba64le',
  'rgba64be',
  'pal8',
]);

/**
 * Ground truth about a produced file, read from the file itself.
 *
 * Deliberately best-effort: a probe failure is logged and the download
 * continues without dimensions. Telegram will still deliver the file, just
 * without an inline preview — which is a far better outcome than failing a
 * download that worked.
 */
export class Ffprobe {
  constructor(private readonly options: FfprobeOptions) {}

  async probe(filePath: string, signal?: AbortSignal): Promise<ProbedMedia | undefined> {
    try {
      const { stdout } = await runProcess({
        executable: this.options.ffprobePath,
        args: [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name,width,height,pix_fmt:stream_tags=rotate:stream_side_data=rotation:format=duration,bit_rate,format_name',
          '-of',
          'json',
          filePath,
        ],
        timeoutMs: this.options.timeoutMs,
        signal,
        label: 'ffprobe',
        logger: this.options.logger,
      });
      return parseFfprobeOutput(stdout);
    } catch (error: unknown) {
      this.options.logger.warn('ffprobe failed; continuing without media metadata', {
        error: describeError(error),
      });
      return undefined;
    }
  }

  async version(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { stdout } = await runProcess({
        executable: this.options.ffprobePath,
        args: ['-version'],
        timeoutMs: 10_000,
        signal,
        label: 'ffprobe-version',
        logger: this.options.logger,
      });
      return stdout.split(/\r?\n/)[0]?.trim();
    } catch {
      return undefined;
    }
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface FfprobeDocument {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

/**
 * Split out from the process call so the parsing rules — which is where the
 * subtleties live — can be unit-tested against captured ffprobe output without
 * needing ffprobe.
 */
export function parseFfprobeOutput(stdout: string): ProbedMedia | undefined {
  let document: FfprobeDocument;
  try {
    document = JSON.parse(stdout) as FfprobeDocument;
  } catch {
    return undefined;
  }

  const streams = document.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const duration = Number(document.format?.duration);
  const bitrate = Number(document.format?.bit_rate);
  const pixelFormat = video?.pix_fmt;

  return {
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    width: video?.width,
    height: video?.height,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    bitrateBps: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined,
    formatName: document.format?.format_name,
    pixelFormat,
    rotationDegrees: readRotation(video),
    hasAlphaChannel: pixelFormat !== undefined && ALPHA_PIXEL_FORMATS.has(pixelFormat),
  };
}

/**
 * Rotation lives in two places depending on how the file was written: the
 * legacy `rotate` tag, and the display-matrix side data modern encoders use.
 * Reading only one of them is how a portrait video ends up sideways.
 */
function readRotation(stream: FfprobeStream | undefined): number | undefined {
  if (stream === undefined) return undefined;
  const sideData = stream.side_data_list?.find((entry) => entry.rotation !== undefined);
  if (sideData?.rotation !== undefined) return normaliseRotation(sideData.rotation);
  const tag = stream.tags?.rotate;
  if (tag !== undefined) {
    const parsed = Number(tag);
    if (Number.isFinite(parsed)) return normaliseRotation(parsed);
  }
  return undefined;
}

function normaliseRotation(value: number): number {
  const normalised = ((Math.round(value) % 360) + 360) % 360;
  return normalised;
}
