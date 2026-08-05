import { dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { ToolError, ToolErrorCode } from '../errors/tool-error.js';
import { runProcess, runProcessOrThrow } from '../process/child-process-runner.js';
import {
  FfmpegProgressParser,
  assertUsableVideo,
  buildMp3Args,
  buildProbeArgs,
  buildRemoveAudioArgs,
  estimateMp3Bytes,
  parseFfprobeJson,
} from './ffmpeg-plan.js';
import type {
  ExtractMp3Options,
  VideoLimits,
  VideoMetadata,
  VideoOperationContext,
  VideoProcessor,
  VideoResult,
} from './video-processor.js';

/**
 * Runs FFmpeg. Everything it DECIDES lives in `ffmpeg-plan.ts`.
 *
 * This file is intentionally thin: it starts processes, watches their output
 * and turns exit codes into typed errors. The split matters because the plan is
 * testable everywhere, while this half needs the binaries present.
 */

export interface FfmpegVideoProcessorOptions {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly limits: VideoLimits;
  /**
   * Refuse to produce something the transport cannot carry.
   *
   * Checked from the DURATION before encoding starts, so a two-hour podcast at
   * 320 kbps is declined in milliseconds rather than after a full extraction.
   */
  readonly maxOutputBytes?: number | undefined;
}

export class FfmpegVideoProcessor implements VideoProcessor {
  constructor(private readonly options: FfmpegVideoProcessorOptions) {}

  async inspect(inputPath: string): Promise<VideoMetadata> {
    const { size } = await stat(inputPath);
    if (size > this.options.limits.maxInputBytes) {
      throw new ToolError(ToolErrorCode.InputTooLarge, 'video is larger than the input ceiling', {
        context: { sizeBytes: size, maxBytes: this.options.limits.maxInputBytes },
      });
    }

    const result = await runProcess({
      command: this.options.ffprobePath,
      args: buildProbeArgs(inputPath),
      cwd: dirname(inputPath),
      timeoutMs: 30_000,
    });

    if (result.exitCode !== 0) {
      throw new ToolError(ToolErrorCode.InvalidVideo, 'ffprobe could not read the file', {
        context: { exitCode: result.exitCode, stderr: result.stderr.slice(0, 1_000) },
      });
    }

    const meta = parseFfprobeJson(result.stdout);
    if (meta === undefined) {
      throw new ToolError(ToolErrorCode.InvalidVideo, 'ffprobe returned output that was not JSON');
    }
    return meta;
  }

  async extractMp3(
    inputPath: string,
    outputPath: string,
    options: ExtractMp3Options,
    context: VideoOperationContext,
  ): Promise<VideoResult> {
    const meta = await this.inspect(inputPath);
    assertUsableVideo(meta, this.options.limits);

    // The distinction the user actually cares about. "No audio to extract" is a
    // fact about their file, not a failure of the tool, and it deserves its own
    // message rather than a generic ffmpeg error after a pointless run.
    if (meta.audio === undefined) {
      throw new ToolError(ToolErrorCode.VideoHasNoAudio, 'file has no audio stream to extract');
    }

    if (this.options.maxOutputBytes !== undefined && meta.durationSeconds !== undefined) {
      const estimate = estimateMp3Bytes(meta.durationSeconds, options.quality);
      if (estimate > this.options.maxOutputBytes) {
        throw new ToolError(ToolErrorCode.OutputTooLarge, 'the MP3 would exceed the send ceiling', {
          context: {
            estimatedBytes: estimate,
            maxBytes: this.options.maxOutputBytes,
            durationSeconds: meta.durationSeconds,
          },
        });
      }
    }

    await this.#runWithProgress(
      buildMp3Args(inputPath, outputPath, options),
      meta.durationSeconds,
      outputPath,
      context,
    );

    return await this.#describe(outputPath, meta.durationSeconds);
  }

  async removeAudio(
    inputPath: string,
    outputPath: string,
    context: VideoOperationContext,
  ): Promise<VideoResult> {
    const meta = await this.inspect(inputPath);
    assertUsableVideo(meta, this.options.limits);

    if (meta.video === undefined) {
      throw new ToolError(ToolErrorCode.InvalidVideo, 'file has no video stream');
    }
    // Doing nothing and charging for it is worse than saying so. The user
    // learns something true about their file instead of receiving a copy.
    if (meta.audio === undefined) {
      throw new ToolError(ToolErrorCode.VideoAlreadyMuted, 'file already has no audio track');
    }

    await this.#runWithProgress(
      buildRemoveAudioArgs(inputPath, outputPath),
      meta.durationSeconds,
      outputPath,
      context,
    );

    return await this.#describe(outputPath, meta.durationSeconds);
  }

  async #runWithProgress(
    args: readonly string[],
    totalSeconds: number | undefined,
    outputPath: string,
    context: VideoOperationContext,
  ): Promise<void> {
    const parser = new FfmpegProgressParser(totalSeconds);

    await runProcessOrThrow({
      command: this.options.ffmpegPath,
      args,
      cwd: dirname(outputPath),
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      onStdout: (chunk) => {
        const fraction = parser.push(chunk);
        if (fraction !== undefined) context.onProgress?.(fraction);
      },
    });
  }

  /**
   * Confirm the file exists and is not empty before calling it a result.
   *
   * FFmpeg can exit 0 having written nothing — a bad `-map` on an unusual
   * container does exactly that — and sending a zero-byte file is a worse
   * failure than reporting one, because it looks like success.
   */
  async #describe(outputPath: string, durationSeconds: number | undefined): Promise<VideoResult> {
    const { size } = await stat(outputPath).catch(() => ({ size: 0 }));
    if (size === 0) {
      throw new ToolError(ToolErrorCode.ExternalToolFailed, 'ffmpeg produced an empty file');
    }
    return { outputPath, sizeBytes: size, durationSeconds };
  }
}
