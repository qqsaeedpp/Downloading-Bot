import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharpImageProcessor, ToolErrorCode, isToolError } from '@tgtools/file-tools-engine';
import type { ImageLimits } from '@tgtools/file-tools-engine';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Exercised against real Sharp, with fixtures generated at run time.
 *
 * Generated rather than committed: a handful of binary images would bloat the
 * repository, drift from what the tests actually need, and tell a reader
 * nothing about WHY each one exists. Built here, the shape under test — a
 * transparent PNG, a sideways JPEG, a pixel bomb — is stated in code.
 */

/**
 * A minimal two-frame animated GIF89a, 1x1 pixel.
 *
 * Committed as bytes rather than generated because Sharp cannot produce an
 * animation from raw pixels — writing one needs an input that already has page
 * metadata, which is exactly what this provides.
 */
const TWO_FRAME_GIF =
  'R0lGODlhAQABAIAAAP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJAAAAACwAAAAAAQABAAACAkQBACH5BAkAAAAALAAAAAABAAEAAAICRAEAOw==';

const LIMITS: ImageLimits = {
  maxPixels: 60_000_000,
  maxDimension: 12_000,
  maxInputBytes: 20 * 1024 * 1024,
};

function codeOf(error: unknown): string | undefined {
  return isToolError(error) ? error.code : undefined;
}

describe('image tools', () => {
  let dir: string;
  let processor: SharpImageProcessor;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tgtools-img-tools-'));
    processor = new SharpImageProcessor({ limits: LIMITS });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A noisy image, because a flat colour compresses to almost nothing. */
  async function makePhoto(width = 1200, height = 900): Promise<string> {
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 256;
    const path = join(dir, `photo-${String(width)}x${String(height)}.jpg`);
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toFile(path);
    return path;
  }

  async function makeTransparentPng(): Promise<string> {
    const path = join(dir, 'transparent.png');
    await sharp({
      create: {
        width: 300,
        height: 200,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toFile(path);
    return path;
  }

  describe('inspect', () => {
    it('reports dimensions, alpha and size', async () => {
      const meta = await processor.inspect(await makeTransparentPng());
      expect(meta).toMatchObject({ width: 300, height: 200, hasAlpha: true, format: 'png' });
      expect(meta.pixels).toBe(60_000);
    });

    it('refuses a file over the input ceiling before decoding it', async () => {
      const path = join(dir, 'big.bin');
      await writeFile(path, Buffer.alloc(2 * 1024 * 1024));
      const tight = new SharpImageProcessor({ limits: { ...LIMITS, maxInputBytes: 1024 } });

      await expect(tight.inspect(path)).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === ToolErrorCode.InputTooLarge,
      );
    });

    it('refuses an image over the pixel ceiling', async () => {
      // The decompression-bomb guard. A small file can declare an enormous
      // canvas, and the allocation is what kills the host.
      const path = await makePhoto(2000, 2000);
      const tight = new SharpImageProcessor({ limits: { ...LIMITS, maxPixels: 1_000_000 } });

      await expect(tight.inspect(path)).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === ToolErrorCode.ImageTooManyPixels,
      );
    });

    it('reports a non-image as invalid rather than crashing', async () => {
      const path = join(dir, 'not-an-image.jpg');
      await writeFile(path, 'this is plainly not a JPEG');

      await expect(processor.inspect(path)).rejects.toSatisfy(
        (e: unknown) => codeOf(e) === ToolErrorCode.InvalidImage,
      );
    });
  });

  describe('compress', () => {
    it('makes a photo smaller', async () => {
      const input = await makePhoto();
      const output = join(dir, 'out.jpg');
      const before = (await stat(input)).size;

      const result = await processor.compress(input, output, { level: 'balanced' });
      expect(result.sizeBytes).toBeLessThan(before);
    });

    it('compresses harder at "maximum" than at "high"', async () => {
      // Asserts the ORDER of the presets. A "maximum" that produced a larger
      // file than "high" would be a silent inversion nobody would notice.
      const input = await makePhoto(1600, 1200);
      const high = await processor.compress(input, join(dir, 'h.jpg'), { level: 'high' });
      const maximum = await processor.compress(input, join(dir, 'm.jpg'), { level: 'maximum' });

      expect(maximum.sizeBytes).toBeLessThan(high.sizeBytes);
    });

    it('keeps transparency instead of flattening it onto a guess', async () => {
      // Compressing a logo to JPEG would composite its alpha onto a background
      // the user never chose.
      const result = await processor.compress(await makeTransparentPng(), join(dir, 'o.webp'), {
        level: 'balanced',
      });
      expect(['webp', 'avif']).toContain(result.format);
    });

    it('hands back the original when re-encoding would grow it', async () => {
      // An already-optimised file often grows. Returning something larger than
      // was sent is worse than doing nothing.
      const input = join(dir, 'tiny.jpg');
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
        .jpeg({ quality: 40 })
        .toFile(input);

      const result = await processor.compress(input, join(dir, 'o.jpg'), { level: 'high' });
      expect(result.keptOriginal).toBe(true);
      expect(result.outputPath).toBe(input);
    });

    it('reaches a realistic target size', async () => {
      const input = await makePhoto(1600, 1200);
      const target = 60 * 1024;

      const result = await processor.compress(input, join(dir, 'target.jpg'), {
        level: 'balanced',
        targetBytes: target,
      });

      expect(result.sizeBytes).toBeLessThanOrEqual(target);
      expect(result.targetMissed).toBeUndefined();
      // The file on disk must match the numbers reported, which is why the
      // winning combination is re-encoded after the search.
      expect((await stat(result.outputPath)).size).toBe(result.sizeBytes);
    });

    it('says so when a target cannot be met, rather than looping', async () => {
      const input = await makePhoto(1600, 1200);
      const result = await processor.compress(input, join(dir, 'impossible.jpg'), {
        level: 'balanced',
        targetBytes: 200,
      });

      expect(result.targetMissed).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('resize', () => {
    it('crops to fill for a cover preset', async () => {
      const result = await processor.resize(await makePhoto(1200, 900), join(dir, 'story.jpg'), {
        width: 1080,
        height: 1920,
        fit: 'cover',
        allowUpscale: true,
      });

      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
    });

    it('letterboxes rather than distorting for contain', async () => {
      const result = await processor.resize(await makePhoto(1200, 900), join(dir, 'contain.jpg'), {
        width: 1080,
        height: 1080,
        fit: 'contain',
        allowUpscale: true,
      });

      expect(result.width).toBe(1080);
      expect(result.height).toBe(1080);
    });

    it('never enlarges unless asked', async () => {
      // A preset larger than the photo must not invent detail that was never
      // captured.
      const result = await processor.resize(await makePhoto(400, 300), join(dir, 'web.jpg'), {
        width: 1920,
        fit: 'inside',
      });

      expect(result.width).toBe(400);
      expect(result.height).toBe(300);
    });

    it('preserves the aspect ratio when only a width is given', async () => {
      const result = await processor.resize(await makePhoto(1200, 900), join(dir, 'w.jpg'), {
        width: 600,
        fit: 'inside',
      });

      expect(result.width).toBe(600);
      expect(result.height).toBe(450);
    });
  });

  describe('convert', () => {
    it('flattens alpha onto white when converting to JPEG', async () => {
      // Left alone, Sharp composites onto BLACK, turning a transparent logo
      // into a black rectangle.
      const result = await processor.convert(await makeTransparentPng(), join(dir, 'flat.jpg'), {
        format: 'jpeg',
      });

      expect(result.format).toBe('jpeg');
      const meta = await sharp(result.outputPath).metadata();
      expect(meta.hasAlpha).toBe(false);

      const { data } = await sharp(result.outputPath).raw().toBuffer({ resolveWithObject: true });
      // Half-opacity red over white is pink, not the dark tone a black
      // background would produce.
      expect(data[0]).toBeGreaterThan(200);
      expect(data[1]).toBeGreaterThan(90);
    });

    it('honours an explicit black background', async () => {
      const result = await processor.convert(await makeTransparentPng(), join(dir, 'black.jpg'), {
        format: 'jpeg',
        background: 'black',
      });

      const { data } = await sharp(result.outputPath).raw().toBuffer({ resolveWithObject: true });
      expect(data[1]).toBeLessThan(60);
    });

    it('keeps alpha when converting to a format that has it', async () => {
      for (const format of ['png', 'webp'] as const) {
        const result = await processor.convert(
          await makeTransparentPng(),
          join(dir, `alpha.${format}`),
          { format },
        );
        const meta = await sharp(result.outputPath).metadata();
        expect(meta.hasAlpha, format).toBe(true);
      }
    });

    it('strips EXIF, which carries GPS coordinates', async () => {
      // A bot that quietly republishes where a photo was taken is a privacy
      // incident, not a missing feature.
      const input = join(dir, 'exif.jpg');
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
        .withExif({ IFD0: { Copyright: 'test', Software: 'tgtools-fixture' } })
        .jpeg()
        .toFile(input);

      const result = await processor.convert(input, join(dir, 'clean.jpg'), { format: 'jpeg' });
      const meta = await sharp(result.outputPath).metadata();
      expect(meta.exif).toBeUndefined();
    });
  });

  describe('animated images', () => {
    it('refuses rather than silently returning the first frame', async () => {
      // Sharp processes page 1 and discards the rest without complaint, so the
      // user would receive a still where they sent a moving image —
      // indistinguishable from the tool having broken it.
      // A hand-built two-frame GIF89a. Sharp can only WRITE an animation from
      // an input that already carries page metadata, which raw pixels cannot,
      // so the fixture is assembled from bytes.
      const path = join(dir, 'animated.gif');
      await writeFile(path, Buffer.from(TWO_FRAME_GIF, 'base64'));

      const meta = await processor.inspect(path);
      expect(meta.isAnimated).toBe(true);

      await expect(
        processor.convert(path, join(dir, 'out.png'), { format: 'png' }),
      ).rejects.toSatisfy((e: unknown) => codeOf(e) === ToolErrorCode.AnimatedImageUnsupported);
    });
  });
});
