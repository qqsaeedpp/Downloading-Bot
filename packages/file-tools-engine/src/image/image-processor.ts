/**
 * What the image tools can be asked to do, independent of how.
 *
 * Sharp appears nowhere in this file. The application layer talks to this
 * interface, which is what lets the compression policy, the preset table and
 * the target-size search be tested without decoding a single pixel.
 */

/** The four formats the first release accepts and emits. */
export const IMAGE_FORMAT_VALUES = ['jpeg', 'png', 'webp', 'avif'] as const;
export type ImageFormat = (typeof IMAGE_FORMAT_VALUES)[number];

export function isImageFormat(value: string): value is ImageFormat {
  return (IMAGE_FORMAT_VALUES as readonly string[]).includes(value);
}

export interface ImageMetadata {
  readonly format: ImageFormat | undefined;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  /**
   * More than one frame — an animated WebP, or a GIF.
   *
   * Load-bearing rather than informational: Sharp silently processes only the
   * first frame, so an animation converted without this check comes back as a
   * still, which looks like corruption to the person who sent it.
   */
  readonly isAnimated: boolean;
  readonly sizeBytes: number;
  /** Total decoded pixels. The number a decompression bomb inflates. */
  readonly pixels: number;
}

export interface ImageLimits {
  readonly maxPixels: number;
  readonly maxDimension: number;
  readonly maxInputBytes: number;
}

/** How aggressively to trade quality for bytes. */
export const COMPRESSION_LEVEL_VALUES = ['high', 'balanced', 'maximum'] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVEL_VALUES)[number];

export interface CompressionPreset {
  readonly quality: number;
  /**
   * Longest side after resizing, or `undefined` to leave dimensions alone.
   *
   * Most of the saving on a modern phone photo comes from here rather than from
   * the quality setting: a 4032-pixel original re-encoded at the same size is
   * still enormous.
   */
  readonly maxLongEdge: number | undefined;
}

/**
 * The three presets, as data.
 *
 * Numbers rather than adjectives so they can be changed without touching the
 * pipeline, and so a test can assert the ORDER — a "maximum" preset that
 * produced a larger file than "balanced" would be a silent inversion.
 */
export const COMPRESSION_PRESETS: Readonly<Record<CompressionLevel, CompressionPreset>> = {
  high: { quality: 88, maxLongEdge: 2560 },
  balanced: { quality: 80, maxLongEdge: 1920 },
  maximum: { quality: 68, maxLongEdge: 1600 },
};

export interface CompressOptions {
  /** Ignored when `targetBytes` is set; the search chooses its own quality. */
  readonly level: CompressionLevel;
  /**
   * Aim for a file at or under this size.
   *
   * Best-effort by construction. Some images cannot reach a small target
   * without becoming unrecognisable, and the honest outcome is the closest
   * result plus a flag saying the target was missed — not an endless loop.
   */
  readonly targetBytes?: number | undefined;
}

/** How a resize fills a box whose aspect ratio differs from the image's. */
export const RESIZE_FIT_VALUES = ['cover', 'contain', 'inside'] as const;
export type ResizeFit = (typeof RESIZE_FIT_VALUES)[number];

export interface ResizeOptions {
  readonly width: number;
  /** Absent means "derive from the width and keep the aspect ratio". */
  readonly height?: number | undefined;
  readonly fit: ResizeFit;
  /** Only meaningful for `contain`. Defaults to white. */
  readonly background?: 'white' | 'black' | 'transparent';
  /**
   * Off by default. Enlarging invents detail that was never captured, so it has
   * to be asked for rather than happening because a preset was bigger than the
   * photo.
   */
  readonly allowUpscale?: boolean;
}

export interface ConvertOptions {
  readonly format: ImageFormat;
  /** Where alpha must be discarded — JPEG — this is what replaces it. */
  readonly background?: 'white' | 'black';
  readonly quality?: number;
  /** WebP only; ignored elsewhere. */
  readonly lossless?: boolean;
}

export interface ImageResult {
  readonly outputPath: string;
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  /** Set when a target size was requested and could not be met. */
  readonly targetMissed?: boolean;
  /**
   * True when the result is the ORIGINAL because every attempt came out
   * larger. An already-optimised file re-encoded at "maximum" often grows, and
   * handing the user a bigger file than they sent is worse than doing nothing.
   */
  readonly keptOriginal?: boolean;
}

export interface ImageProcessor {
  inspect(inputPath: string): Promise<ImageMetadata>;
  compress(inputPath: string, outputPath: string, options: CompressOptions): Promise<ImageResult>;
  resize(inputPath: string, outputPath: string, options: ResizeOptions): Promise<ImageResult>;
  convert(inputPath: string, outputPath: string, options: ConvertOptions): Promise<ImageResult>;
}

/**
 * The named output sizes offered in the menu.
 *
 * `cover` crops to fill and is right for a feed, where a letterboxed picture
 * looks broken. `inside` never enlarges and is right for the web, where the
 * point is a ceiling rather than an exact shape.
 *
 * `fill` appears nowhere: it stretches, and a stretched face is the one result
 * nobody ever wants.
 */
export const RESIZE_PRESETS = {
  postSquare: { width: 1080, height: 1080, fit: 'cover' },
  postPortrait: { width: 1080, height: 1350, fit: 'cover' },
  postLandscape: { width: 1080, height: 566, fit: 'cover' },
  story: { width: 1080, height: 1920, fit: 'cover' },
  webSmall: { width: 1200, fit: 'inside' },
  webStandard: { width: 1600, fit: 'inside' },
  webLarge: { width: 1920, fit: 'inside' },
  openGraph: { width: 1200, height: 630, fit: 'cover' },
  thumbnail: { width: 400, height: 400, fit: 'cover' },
} as const satisfies Record<string, ResizeOptions>;

export type ResizePresetKey = keyof typeof RESIZE_PRESETS;

export function isResizePresetKey(value: string): value is ResizePresetKey {
  return Object.hasOwn(RESIZE_PRESETS, value);
}
