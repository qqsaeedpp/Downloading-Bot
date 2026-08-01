import { rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import { runProcess } from '../process/run-process.js';
import type { Ffprobe } from './ffprobe.js';

/** Telegram's `sendPhoto` accepts these directly and previews them inline. */
const NATIVELY_SUPPORTED = new Set(['.jpg', '.jpeg', '.png']);

export interface ImageNormalizerOptions {
  readonly ffmpegPath: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

export interface NormalizedImage {
  readonly filePath: string;
  readonly converted: boolean;
  readonly format: 'jpeg' | 'png' | 'original';
}

/**
 * Bring a downloaded still into a format Telegram will preview.
 *
 * The one decision worth spelling out: WebP is converted, but *to what* depends
 * on whether it carries transparency. Flattening an alpha channel into JPEG
 * replaces it with black, which on a sticker-style pin ruins the image; PNG
 * preserves it at the cost of size. Neither is universally right, so the file
 * decides.
 */
export class ImageNormalizer {
  constructor(
    private readonly options: ImageNormalizerOptions,
    private readonly ffprobe: Ffprobe,
  ) {}

  async normalize(filePath: string, signal?: AbortSignal): Promise<NormalizedImage> {
    const extension = extname(filePath).toLowerCase();
    if (NATIVELY_SUPPORTED.has(extension)) {
      return { filePath, converted: false, format: 'original' };
    }

    const probe = await this.ffprobe.probe(filePath, signal);
    const useAlpha = probe?.hasAlphaChannel ?? false;
    const targetExtension = useAlpha ? '.png' : '.jpg';
    const target = join(
      dirname(filePath),
      `${basename(filePath, extname(filePath))}${targetExtension}`,
    );

    try {
      await runProcess({
        executable: this.options.ffmpegPath,
        args: [
          '-loglevel',
          'error',
          '-y',
          '-i',
          filePath,
          // No scaling: upscaling a small pin adds bytes and no detail, and
          // downscaling loses the resolution the user asked for.
          ...(useAlpha ? [] : ['-pix_fmt', 'yuvj420p', '-q:v', '2']),
          target,
        ],
        timeoutMs: this.options.timeoutMs,
        signal,
        label: 'ffmpeg-image',
        logger: this.options.logger,
      });
      await rm(filePath, { force: true });
      return { filePath: target, converted: true, format: useAlpha ? 'png' : 'jpeg' };
    } catch (error: unknown) {
      // Sending the original as a document still beats sending nothing.
      this.options.logger.warn('image conversion failed; keeping the original', {
        error: describeError(error),
      });
      return { filePath, converted: false, format: 'original' };
    }
  }
}
