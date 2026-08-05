import { ToolError, ToolErrorCode } from '../errors/tool-error.js';
import type {
  ExtractMp3Options,
  Mp3Quality,
  VideoLimits,
  VideoMetadata,
} from './video-processor.js';

/**
 * Everything about the video tools that can be decided without running
 * anything: parsing what ffprobe said, deciding whether the file is usable,
 * building the argument vectors, and reading progress back.
 *
 * Kept pure and separate from the process orchestration because FFmpeg is not
 * available on every machine this code is written on, and because these are
 * where the real mistakes live — an argument in the wrong ORDER silently
 * changes what ffmpeg does, and a progress parser that misreads a field shows a
 * user 4000%.
 */

interface RawStream {
  readonly codec_type?: unknown;
  readonly codec_name?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly channels?: unknown;
  readonly bit_rate?: unknown;
}

interface RawProbe {
  readonly streams?: unknown;
  readonly format?: {
    readonly duration?: unknown;
    readonly size?: unknown;
    readonly bit_rate?: unknown;
    readonly format_name?: unknown;
  };
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    // ffprobe writes "N/A" for anything it could not determine, which becomes
    // NaN — and a NaN duration propagated into a size estimate produces a
    // NaN ceiling that every comparison silently passes.
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * The first stream of a given kind, narrowed one element at a time.
 *
 * Everything inside a parsed JSON document is `unknown`, and treating the array
 * as already-typed is how a malformed probe turns into a property access on a
 * number.
 */
function findStream(streams: unknown, kind: 'video' | 'audio'): RawStream | undefined {
  if (!Array.isArray(streams)) return undefined;
  for (const entry of streams as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const stream = entry as RawStream;
    if (stream.codec_type === kind) return stream;
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Parse `ffprobe -show_streams -show_format -of json`.
 *
 * Returns `undefined` rather than throwing for output that is not JSON at all:
 * that means ffprobe failed, and the caller's exit-code check produces a better
 * message than a parse error would.
 */
export function parseFfprobeJson(stdout: string): VideoMetadata | undefined {
  let raw: RawProbe;
  try {
    const parsed: unknown = JSON.parse(stdout);
    // `JSON.parse` succeeds on "null", "42" and "[]" as readily as on an
    // object, and every property access below would then throw. Valid JSON is
    // not the same question as usable ffprobe output.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    raw = parsed;
  } catch {
    return undefined;
  }

  // The FIRST stream of each kind. A file can carry several audio tracks and
  // the tools deliberately take track zero rather than guessing which language
  // the user wanted — a choice worth surfacing in the UI later, not silently.
  const videoStream = findStream(raw.streams, 'video');
  const audioStream = findStream(raw.streams, 'audio');

  return {
    durationSeconds: asNumber(raw.format?.duration),
    formatName: asText(raw.format?.format_name),
    sizeBytes: asNumber(raw.format?.size),
    bitrateBps: asNumber(raw.format?.bit_rate),
    video:
      videoStream === undefined
        ? undefined
        : {
            codec: asText(videoStream.codec_name),
            width: asNumber(videoStream.width),
            height: asNumber(videoStream.height),
          },
    audio:
      audioStream === undefined
        ? undefined
        : {
            codec: asText(audioStream.codec_name),
            channels: asNumber(audioStream.channels),
            bitrateBps: asNumber(audioStream.bit_rate),
          },
  };
}

/**
 * Refuse a file the tools cannot work with, before FFmpeg is started.
 *
 * Each of these takes seconds to check and would otherwise cost the full
 * processing time to discover.
 */
export function assertUsableVideo(meta: VideoMetadata, limits: VideoLimits): void {
  if (meta.video === undefined && meta.audio === undefined) {
    throw new ToolError(ToolErrorCode.InvalidVideo, 'file carries neither video nor audio');
  }
  if (meta.durationSeconds !== undefined && meta.durationSeconds > limits.maxDurationSeconds) {
    throw new ToolError(ToolErrorCode.VideoTooLong, 'video is longer than the ceiling', {
      context: {
        durationSeconds: meta.durationSeconds,
        maxDurationSeconds: limits.maxDurationSeconds,
      },
    });
  }
}

/** Bits per second the chosen MP3 setting produces, for estimating output size. */
export function mp3BitrateBps(quality: Mp3Quality): number {
  // VBR at `-q:a 2` averages around 190 kbps on typical material. Used only for
  // an estimate, so being a little high is the safe direction: it refuses a
  // borderline job rather than discovering the problem after the encode.
  return quality === 'vbr' ? 190_000 : Number(quality) * 1000;
}

/**
 * Predict the MP3's size so an undeliverable job can be refused up front.
 *
 * Bitrate times duration is exact for CBR and close enough for VBR. Without
 * this the user waits through a full extraction to be told the result is too
 * large to send.
 */
export function estimateMp3Bytes(durationSeconds: number, quality: Mp3Quality): number {
  return Math.ceil((durationSeconds * mp3BitrateBps(quality)) / 8);
}

/**
 * The argument vector for extracting audio as MP3.
 *
 * `-vn` and `-map 0:a:0` together: the map picks the first audio track, and
 * `-vn` guarantees no video stream is carried even if the container would
 * allow one. Either alone leaves a case where a cover image rides along and
 * turns a 4 MB MP3 into a 40 MB one.
 *
 * `-progress pipe:1 -nostats` replaces FFmpeg's human-readable progress with a
 * key=value stream on stdout, which can be parsed without regular expressions
 * over a carriage-return-laden status line.
 */
export function buildMp3Args(
  inputPath: string,
  outputPath: string,
  options: ExtractMp3Options,
): string[] {
  const quality: string[] =
    options.quality === 'vbr' ? ['-q:a', '2'] : ['-b:a', `${options.quality}k`];

  return [
    '-hide_banner',
    // Without this FFmpeg can block forever waiting on stdin when it thinks it
    // needs to ask about overwriting.
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    'libmp3lame',
    ...quality,
    // Windows Media Player and several car head units ignore ID3v2.4 tags
    // entirely; v2.3 is the version everything reads.
    '-id3v2_version',
    '3',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath,
  ];
}

/**
 * The argument vector for removing the audio track.
 *
 * `-c:v copy` is the whole point: the video stream is transferred byte for
 * byte, so a two-hour film is a disk copy rather than a two-hour re-encode and
 * loses no quality at all. `-map 0:v:0` is mandatory — a file that reached here
 * has a video stream, and if it does not, failing loudly beats emitting an
 * audio-only "video".
 */
export function buildRemoveAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-an',
    // Moves the index to the front so the result plays before it has fully
    // downloaded. Free here, since nothing is being re-encoded.
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

/** The arguments for probing. Kept beside the others so the whole CLI surface is in one file. */
export function buildProbeArgs(inputPath: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    inputPath,
  ];
}

/**
 * Reads FFmpeg's `-progress` stream.
 *
 * The format is `key=value` lines, with `out_time_us` (or `out_time_ms` on
 * older builds, which despite its name is also MICROseconds) reporting how far
 * through the input it is. Stateful because the stream arrives in arbitrary
 * chunks that split lines.
 */
export class FfmpegProgressParser {
  #buffer = '';

  constructor(private readonly totalSeconds: number | undefined) {}

  /** Returns 0..1, or `undefined` when this chunk revealed nothing new. */
  push(chunk: string): number | undefined {
    this.#buffer += chunk;
    const lines = this.#buffer.split('\n');
    // The final element is whatever came after the last newline: an incomplete
    // line that must be held over rather than parsed.
    this.#buffer = lines.pop() ?? '';

    let latest: number | undefined;
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();

      if (key === 'out_time_us' || key === 'out_time_ms') {
        const microseconds = Number(value);
        // FFmpeg emits "N/A" before the first frame is written.
        if (Number.isFinite(microseconds) && microseconds >= 0) latest = microseconds / 1_000_000;
      } else if (key === 'progress' && value === 'end') {
        // The one unambiguous completion signal.
        return 1;
      }
    }

    if (latest === undefined) return undefined;
    if (this.totalSeconds === undefined || this.totalSeconds <= 0) return undefined;
    // Clamped: a container whose declared duration is short by a frame would
    // otherwise report 101%.
    return Math.min(1, Math.max(0, latest / this.totalSeconds));
  }
}
