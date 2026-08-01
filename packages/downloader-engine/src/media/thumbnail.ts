import { stat } from 'node:fs/promises';
import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import { runProcess } from '../process/run-process.js';

/**
 * Telegram rejects a thumbnail larger than 320x320 or heavier than 200 KB, so
 * the box is fixed and the aspect ratio is preserved inside it — which is what
 * keeps a portrait reel's poster from being squashed.
 */
const THUMBNAIL_BOX = 320;
const TELEGRAM_THUMBNAIL_MAX_BYTES = 200 * 1024;

export interface ThumbnailOptions {
  readonly ffmpegPath: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

export class ThumbnailGenerator {
  constructor(private readonly options: ThumbnailOptions) {}

  /**
   * Grab a representative frame.
   *
   * Taken from ~10% in rather than from the start: the first frames of a reel
   * are very often a black fade, which makes for a poster that says nothing.
   * Failure is never fatal — a video without a thumbnail still sends.
   */
  async generate(
    videoPath: string,
    durationSeconds: number | undefined,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const outputPath = `${videoPath}.thumb.jpg`;
    const seekSeconds = pickSeekPoint(durationSeconds);

    for (const seek of [seekSeconds, 0]) {
      try {
        await runProcess({
          executable: this.options.ffmpegPath,
          args: [
            '-loglevel',
            'error',
            '-y',
            // Seeking before `-i` is orders of magnitude faster, and precision
            // is irrelevant for a poster frame.
            ...(seek > 0 ? ['-ss', seek.toFixed(2)] : []),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            '-vf',
            `scale=${THUMBNAIL_BOX}:${THUMBNAIL_BOX}:force_original_aspect_ratio=decrease`,
            '-q:v',
            '4',
            '-f',
            'image2',
            outputPath,
          ],
          timeoutMs: this.options.timeoutMs,
          signal,
          label: 'ffmpeg-thumbnail',
          logger: this.options.logger,
        });

        const { size } = await stat(outputPath);
        if (size > 0 && size <= TELEGRAM_THUMBNAIL_MAX_BYTES) return outputPath;
        this.options.logger.debug('thumbnail rejected on size', { size });
        return undefined;
      } catch (error: unknown) {
        // A clip shorter than the seek point yields no frame; the second pass
        // takes the very first one instead.
        if (seek === 0) {
          this.options.logger.debug('thumbnail generation failed', {
            error: describeError(error),
          });
          return undefined;
        }
      }
    }
    return undefined;
  }
}

/** 10% in, clamped so a very short clip still lands on a real frame. */
export function pickSeekPoint(durationSeconds: number | undefined): number {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 1;
  }
  if (durationSeconds <= 2) return 0;
  return Math.min(Math.max(durationSeconds * 0.1, 0.5), 10);
}
