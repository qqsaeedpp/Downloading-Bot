/**
 * What the video tools can be asked to do, independent of FFmpeg.
 */

export interface VideoStreamInfo {
  readonly codec: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
}

export interface AudioStreamInfo {
  readonly codec: string | undefined;
  readonly channels: number | undefined;
  readonly bitrateBps: number | undefined;
}

export interface VideoMetadata {
  readonly durationSeconds: number | undefined;
  readonly formatName: string | undefined;
  readonly sizeBytes: number | undefined;
  readonly bitrateBps: number | undefined;
  readonly video: VideoStreamInfo | undefined;
  readonly audio: AudioStreamInfo | undefined;
}

export interface VideoLimits {
  readonly maxInputBytes: number;
  readonly maxDurationSeconds: number;
}

/**
 * MP3 quality, as the user chooses it.
 *
 * `vbr` is offered because it is genuinely better for most material: a constant
 * 320 kbps spends the same bits on silence as on a cymbal crash, where VBR at
 * `-q:a 2` lands around 190 kbps average with fewer audible artefacts.
 */
export const MP3_QUALITY_VALUES = ['128', '192', '320', 'vbr'] as const;
export type Mp3Quality = (typeof MP3_QUALITY_VALUES)[number];

export function isMp3Quality(value: string): value is Mp3Quality {
  return (MP3_QUALITY_VALUES as readonly string[]).includes(value);
}

export interface ExtractMp3Options {
  readonly quality: Mp3Quality;
}

export interface VideoResult {
  readonly outputPath: string;
  readonly sizeBytes: number;
  readonly durationSeconds: number | undefined;
}

/** Fractional progress, 0..1, or `undefined` while the total is still unknown. */
export type VideoProgressListener = (fraction: number) => void;

export interface VideoOperationContext {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: VideoProgressListener | undefined;
  readonly timeoutMs: number;
}

export interface VideoProcessor {
  inspect(inputPath: string): Promise<VideoMetadata>;
  extractMp3(
    inputPath: string,
    outputPath: string,
    options: ExtractMp3Options,
    context: VideoOperationContext,
  ): Promise<VideoResult>;
  /** Strips the audio track WITHOUT re-encoding the video. */
  removeAudio(
    inputPath: string,
    outputPath: string,
    context: VideoOperationContext,
  ): Promise<VideoResult>;
}
