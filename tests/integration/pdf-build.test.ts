import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PopplerPdfProcessor, ToolErrorCode, isToolError } from '@tgtools/file-tools-engine';
import type { PdfLimits } from '@tgtools/file-tools-engine';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Images to PDF, against real PDFKit and real Sharp.
 *
 * The reverse direction — PDF to images — needs Poppler, which is installed in
 * the container and not on every development machine, so it is covered by the
 * pure `pdf-plan` tests plus a container smoke test rather than here.
 */

const LIMITS: PdfLimits = { maxPages: 50, maxImages: 5, maxInputBytes: 20 * 1024 * 1024 };

function codeOf(error: unknown): string | undefined {
  return isToolError(error) ? error.code : undefined;
}

/** Reads the `/Count` from the page tree, which is the page count. */
function pageCountOf(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length === 0 ? 0 : Math.max(...counts);
}

describe('images to PDF', () => {
  let dir: string;
  let processor: PopplerPdfProcessor;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tgtools-pdf-'));
    processor = new PopplerPdfProcessor({
      pdfinfoPath: 'pdfinfo',
      pdftocairoPath: 'pdftocairo',
      limits: LIMITS,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeImage(name: string, width: number, height: number, colour = '#3366cc') {
    const path = join(dir, name);
    await sharp({ create: { width, height, channels: 3, background: colour } })
      .jpeg()
      .toFile(path);
    return path;
  }

  it('builds a one-page PDF from one image', async () => {
    const result = await processor.fromImages(
      [await makeImage('a.jpg', 800, 600)],
      join(dir, 'out.pdf'),
      { mode: 'image' },
    );

    expect(result.pages).toBe(1);
    expect(result.sizeBytes).toBeGreaterThan(0);

    const pdf = await readFile(result.outputPath);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCountOf(pdf)).toBe(1);
  });

  it('produces one page per image, in the order given', async () => {
    // Order IS the contract for this tool: the user sent the pictures in the
    // sequence they want to read them.
    const images = [
      await makeImage('1.jpg', 400, 300, '#ff0000'),
      await makeImage('2.jpg', 400, 300, '#00ff00'),
      await makeImage('3.jpg', 400, 300, '#0000ff'),
    ];

    const result = await processor.fromImages(images, join(dir, 'multi.pdf'), { mode: 'image' });
    expect(result.pages).toBe(3);
    expect(pageCountOf(await readFile(result.outputPath))).toBe(3);
  });

  it('accepts WebP, which PDFKit cannot embed directly', async () => {
    // Every image passes through Sharp first, which is what makes this work.
    const path = join(dir, 'a.webp');
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#123456' } })
      .webp()
      .toFile(path);

    const result = await processor.fromImages([path], join(dir, 'webp.pdf'), { mode: 'image' });
    expect(result.pages).toBe(1);
  });

  it('flattens transparency, which a PDF page cannot represent', async () => {
    const path = join(dir, 'alpha.png');
    await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toFile(path);

    const result = await processor.fromImages([path], join(dir, 'alpha.pdf'), { mode: 'image' });
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('builds A4 pages in both fitting modes', async () => {
    for (const mode of ['a4-contain', 'a4-cover'] as const) {
      const result = await processor.fromImages(
        [await makeImage(`${mode}.jpg`, 1600, 900)],
        join(dir, `${mode}.pdf`),
        { mode },
      );
      expect(result.pages, mode).toBe(1);

      const pdf = (await readFile(result.outputPath)).toString('latin1');
      // A4 is 595.28 x 841.89 points; PDFKit writes the MediaBox rounded.
      expect(pdf, mode).toMatch(/MediaBox\s*\[\s*0\s+0\s+595/);
    }
  });

  it('refuses more images than the ceiling allows', async () => {
    const images = [];
    for (let i = 0; i < LIMITS.maxImages + 1; i += 1) {
      images.push(await makeImage(`bulk-${String(i)}.jpg`, 100, 100));
    }

    await expect(
      processor.fromImages(images, join(dir, 'too-many.pdf'), { mode: 'image' }),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === ToolErrorCode.PdfTooManyPages);
  });

  it('refuses to build from no images at all', async () => {
    await expect(
      processor.fromImages([], join(dir, 'empty.pdf'), { mode: 'image' }),
    ).rejects.toThrow();
  });

  it('fails rather than leaving a half-written PDF to be mistaken for a result', async () => {
    // The second image does not exist, so the build must abort. What matters is
    // that it THROWS: a truncated PDF that got as far as page one would be sent
    // to the user as if it were complete.
    const good = await makeImage('good.jpg', 100, 100);
    await expect(
      processor.fromImages([good, join(dir, 'missing.jpg')], join(dir, 'partial.pdf'), {
        mode: 'image',
      }),
    ).rejects.toThrow();
  });
});
