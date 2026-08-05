import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import type { Metadata, Sharp } from 'sharp';
import { ToolError, ToolErrorCode } from '../errors/tool-error.js';
import type {
  CompressOptions,
  ConvertOptions,
  ImageFormat,
  ImageLimits,
  ImageMetadata,
  ImageProcessor,
  ImageResult,
  ResizeOptions,
} from './image-processor.js';
import { COMPRESSION_PRESETS, isImageFormat } from './image-processor.js';
import type { TargetSearchPolicy } from './target-size-search.js';
import { DEFAULT_TARGET_SEARCH_POLICY, searchForTargetSize } from './target-size-search.js';

/**
 * The Sharp-backed image tools.
 *
 * Three rules are applied to every pipeline, before anything specific to the
 * requested operation:
 *
 *  - `rotate()` with no argument bakes in the EXIF orientation. Without it a
 *    photo taken sideways stays sideways once the metadata is stripped, which
 *    is the single most common complaint about tools like this.
 *  - the working colour space is sRGB, because a Display-P3 photo re-encoded
 *    without conversion arrives visibly washed out.
 *  - metadata is NOT copied forward. EXIF carries GPS coordinates, and a bot
 *    that quietly republishes where a photo was taken is a privacy incident.
 */

export interface SharpImageProcessorOptions {
  readonly limits: ImageLimits;
  readonly targetSearch?: TargetSearchPolicy;
}

/**
 * libvips caches decoded operations across calls.
 *
 * Wrong for this workload twice over: a worker never sees the same file twice,
 * so the cache can never hit — and it keeps the underlying files OPEN, which on
 * Windows makes the job workspace undeletable and everywhere makes memory grow
 * with the number of jobs rather than with the size of one.
 */
sharp.cache(false);

const BACKGROUNDS = {
  white: { r: 255, g: 255, b: 255, alpha: 1 },
  black: { r: 0, g: 0, b: 0, alpha: 1 },
  transparent: { r: 0, g: 0, b: 0, alpha: 0 },
} as const;

export class SharpImageProcessor implements ImageProcessor {
  readonly #search: TargetSearchPolicy;

  constructor(private readonly options: SharpImageProcessorOptions) {
    this.#search = options.targetSearch ?? DEFAULT_TARGET_SEARCH_POLICY;
  }

  /**
   * Open an image with the decompression-bomb guard in place.
   *
   * `limitInputPixels` makes Sharp refuse before allocating, which is the whole
   * defence: a 40 KB PNG can declare 60000x60000, and by the time a naive
   * pipeline discovers that, the host has already tried to allocate 14 GB.
   *
   * `failOn: 'warning'` is deliberately strict. A truncated JPEG that decodes
   * to half an image is worse than a clear error, because the user receives
   * something that looks like the tool damaged their file.
   */
  #open(inputPath: string): Sharp {
    return sharp(inputPath, {
      failOn: 'warning',
      limitInputPixels: this.options.limits.maxPixels,
      sequentialRead: true,
      // Read every frame, so an animation can be DETECTED. Sharp otherwise
      // reports page 1 and the check below could never fire.
      animated: true,
    });
  }

  async inspect(inputPath: string): Promise<ImageMetadata> {
    const { size } = await stat(inputPath);
    if (size > this.options.limits.maxInputBytes) {
      throw new ToolError(ToolErrorCode.InputTooLarge, 'image is larger than the input ceiling', {
        context: { sizeBytes: size, maxBytes: this.options.limits.maxInputBytes },
      });
    }

    let meta: Metadata;
    try {
      meta = await this.#open(inputPath).metadata();
    } catch (error: unknown) {
      // Sharp's own `limitInputPixels` guard fires during `metadata()`, BEFORE
      // the explicit check below can run. Reported as a decode failure it reads
      // as "your file is broken", when the truth is "your file is enormous" —
      // and only one of those tells the user what to do about it.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('exceeds pixel limit')) {
        throw new ToolError(ToolErrorCode.ImageTooManyPixels, 'image exceeds the pixel ceiling', {
          cause: error,
          context: { maxPixels: this.options.limits.maxPixels },
        });
      }
      throw new ToolError(ToolErrorCode.InvalidImage, 'image could not be decoded', {
        cause: error,
      });
    }

    const width = meta.width ?? 0;
    // For an animated image Sharp reports the height of the whole filmstrip, so
    // the per-frame height is what actually describes the picture.
    const height = meta.pageHeight ?? meta.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new ToolError(ToolErrorCode.InvalidImage, 'image reports no usable dimensions');
    }

    const pixels = width * height;
    if (
      width > this.options.limits.maxDimension ||
      height > this.options.limits.maxDimension ||
      pixels > this.options.limits.maxPixels
    ) {
      throw new ToolError(ToolErrorCode.ImageTooManyPixels, 'image exceeds the pixel ceiling', {
        context: { width, height, pixels, maxPixels: this.options.limits.maxPixels },
      });
    }

    const format =
      meta.format !== undefined && isImageFormat(meta.format) ? meta.format : undefined;

    return {
      format,
      width,
      height,
      hasAlpha: meta.hasAlpha ?? false,
      isAnimated: (meta.pages ?? 1) > 1,
      sizeBytes: size,
      pixels,
    };
  }

  /**
   * Reject an animation rather than silently returning its first frame.
   *
   * Sharp processes page 1 and discards the rest without complaint, so the user
   * would receive a still where they sent a moving image — indistinguishable
   * from the tool having broken it.
   */
  #assertStill(meta: ImageMetadata): void {
    if (meta.isAnimated) {
      throw new ToolError(
        ToolErrorCode.AnimatedImageUnsupported,
        'animated images are not supported in this release',
        { context: { format: meta.format } },
      );
    }
  }

  /** The shared preamble: orientation baked in, colour space normalised. */
  #base(inputPath: string): Sharp {
    return this.#open(inputPath).rotate().toColorspace('srgb');
  }

  async compress(
    inputPath: string,
    outputPath: string,
    options: CompressOptions,
  ): Promise<ImageResult> {
    const meta = await this.inspect(inputPath);
    this.#assertStill(meta);

    const format = outputFormatFor(meta);
    const preset = COMPRESSION_PRESETS[options.level];

    if (options.targetBytes === undefined) {
      const longEdge = preset.maxLongEdge;
      const scale =
        longEdge === undefined ? 1 : Math.min(1, longEdge / Math.max(meta.width, meta.height));
      const size = await this.#encode(inputPath, outputPath, format, preset.quality, scale, meta);

      // An already-optimised file often GROWS when re-encoded. Handing back
      // something larger than was sent is worse than doing nothing, so the
      // caller is told to keep the original.
      if (size >= meta.sizeBytes) {
        return {
          outputPath: inputPath,
          format: meta.format ?? format,
          width: meta.width,
          height: meta.height,
          sizeBytes: meta.sizeBytes,
          keptOriginal: true,
        };
      }
      return await this.#describe(outputPath, format, size);
    }

    const outcome = await searchForTargetSize(
      options.targetBytes,
      (quality, scale) => this.#encode(inputPath, outputPath, format, quality, scale, meta),
      this.#search,
    );

    // The search leaves the LAST attempt on disk, which is not necessarily the
    // one it chose. Re-encoding the winner is one extra pass and the only way
    // the file matches the reported numbers.
    const finalSize = await this.#encode(
      inputPath,
      outputPath,
      format,
      outcome.quality,
      outcome.scale,
      meta,
    );

    const described = await this.#describe(outputPath, format, finalSize);
    return outcome.met ? described : { ...described, targetMissed: true };
  }

  async resize(
    inputPath: string,
    outputPath: string,
    options: ResizeOptions,
  ): Promise<ImageResult> {
    const meta = await this.inspect(inputPath);
    this.#assertStill(meta);

    const format = outputFormatFor(meta);
    const background = BACKGROUNDS[options.background ?? 'white'];

    let pipeline = this.#base(inputPath).resize({
      width: options.width,
      ...(options.height === undefined ? {} : { height: options.height }),
      fit: options.fit,
      // Enlarging invents detail that was never captured. `inside` refuses by
      // definition; the others are told explicitly.
      withoutEnlargement: options.allowUpscale !== true,
      background,
      // `attention` crops toward the busiest region, which keeps faces in frame
      // far more often than a centre crop on a portrait.
      ...(options.fit === 'cover' ? { position: sharp.strategy.attention } : {}),
    });

    // A transparent background only survives in a format that has alpha.
    if (options.background === 'transparent' && format === 'jpeg') {
      pipeline = pipeline.flatten({ background: BACKGROUNDS.white });
    }

    await applyFormat(pipeline, format, {}).toFile(outputPath);
    const { size } = await stat(outputPath);
    return await this.#describe(outputPath, format, size);
  }

  async convert(
    inputPath: string,
    outputPath: string,
    options: ConvertOptions,
  ): Promise<ImageResult> {
    const meta = await this.inspect(inputPath);
    this.#assertStill(meta);

    let pipeline = this.#base(inputPath);

    // JPEG has no alpha. Left alone, Sharp composites onto black, which turns a
    // transparent logo into a black rectangle.
    if (options.format === 'jpeg' && meta.hasAlpha) {
      pipeline = pipeline.flatten({ background: BACKGROUNDS[options.background ?? 'white'] });
    }

    await applyFormat(pipeline, options.format, {
      ...(options.quality === undefined ? {} : { quality: options.quality }),
      ...(options.lossless === undefined ? {} : { lossless: options.lossless }),
    }).toFile(outputPath);

    const { size } = await stat(outputPath);
    return await this.#describe(outputPath, options.format, size);
  }

  async #encode(
    inputPath: string,
    outputPath: string,
    format: ImageFormat,
    quality: number,
    scale: number,
    meta: ImageMetadata,
  ): Promise<number> {
    let pipeline = this.#base(inputPath);

    if (scale < 1) {
      pipeline = pipeline.resize({
        width: Math.max(1, Math.round(meta.width * scale)),
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    await applyFormat(pipeline, format, { quality }).toFile(outputPath);
    const { size } = await stat(outputPath);
    return size;
  }

  async #describe(path: string, format: ImageFormat, sizeBytes: number): Promise<ImageResult> {
    const meta = await sharp(path).metadata();
    return {
      outputPath: path,
      format,
      width: meta.width ?? 0,
      height: meta.pageHeight ?? meta.height ?? 0,
      sizeBytes,
    };
  }
}

/**
 * What to emit when the caller did not say.
 *
 * Transparency is the deciding factor. Compressing a PNG logo to JPEG would
 * flatten its alpha onto a background the user never chose, so anything with an
 * alpha channel stays in a format that has one.
 */
function outputFormatFor(meta: ImageMetadata): ImageFormat {
  if (meta.hasAlpha) return meta.format === 'avif' ? 'avif' : 'webp';
  if (meta.format === 'png') return 'jpeg';
  return meta.format ?? 'jpeg';
}

interface FormatOptions {
  readonly quality?: number;
  readonly lossless?: boolean;
}

function applyFormat(pipeline: Sharp, format: ImageFormat, options: FormatOptions): Sharp {
  const quality = options.quality ?? 82;
  switch (format) {
    case 'jpeg':
      // `mozjpeg` is a straight win: the same visual quality in fewer bytes.
      // `progressive` makes a large photo render top-to-bottom while loading.
      return pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
    case 'png':
      return pipeline.png({ compressionLevel: 9 });
    case 'webp':
      return pipeline.webp({ quality, ...(options.lossless === true ? { lossless: true } : {}) });
    case 'avif':
      // Effort 4 rather than the maximum 9: the last few steps cost several
      // times the CPU for a few percent of size, on a worker shared with
      // everyone else's jobs.
      return pipeline.avif({ quality, effort: 4 });
  }
}
