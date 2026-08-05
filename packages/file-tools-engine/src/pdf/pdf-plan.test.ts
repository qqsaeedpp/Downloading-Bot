import { describe, expect, it } from 'vitest';
import { ToolErrorCode, isToolError } from '../errors/tool-error.js';
import type { PdfLimits } from './pdf-plan.js';
import {
  PAGE_SIZES,
  assertUsablePdf,
  buildPdftocairoArgs,
  pageFileName,
  pageNumberPadding,
  parsePdfInfo,
  planImagePlacement,
  resolvePageRange,
} from './pdf-plan.js';

const LIMITS: PdfLimits = { maxPages: 50, maxImages: 50, maxInputBytes: 20 * 1024 * 1024 };

function codeOf(error: unknown): string | undefined {
  return isToolError(error) ? error.code : undefined;
}

/** Real `pdfinfo` output, trimmed. */
const PDFINFO_PLAIN = `Title:          Example
Pages:          3
Encrypted:      no
Page size:      595.28 x 841.89 pts (A4)
File size:      12345 bytes`;

describe('parsePdfInfo', () => {
  it('reads the page count, encryption and page size', () => {
    const info = parsePdfInfo(PDFINFO_PLAIN);
    expect(info).toMatchObject({ pages: 3, encrypted: false });
    expect(info?.firstPageWidth).toBeCloseTo(595.28, 2);
    expect(info?.firstPageHeight).toBeCloseTo(841.89, 2);
  });

  it('recognises the parenthesised form Poppler uses for encrypted files', () => {
    // "yes (print:no copy:no ...)" — an equality test against "yes" misses it
    // and the tool then tries to render a file it cannot read.
    const info = parsePdfInfo(`Pages: 1\nEncrypted: yes (print:no copy:no change:no addNotes:no)`);
    expect(info?.encrypted).toBe(true);
  });

  it('treats anything that is not plainly "no" as encrypted', () => {
    // Failing safe: refusing a readable file is recoverable, attempting an
    // unreadable one wastes the render and produces a confusing error.
    expect(parsePdfInfo('Pages: 1\nEncrypted: unknown')?.encrypted).toBe(true);
  });

  it('returns undefined when there is no page count', () => {
    // How a non-PDF and a corrupt one both present.
    for (const bad of ['', 'Syntax Error: Could not read PDF', 'Pages: 0', 'Pages: abc']) {
      expect(parsePdfInfo(bad), bad).toBeUndefined();
    }
  });

  it('survives output with no page size line', () => {
    const info = parsePdfInfo('Pages: 2\nEncrypted: no');
    expect(info?.pages).toBe(2);
    expect(info?.firstPageWidth).toBeUndefined();
  });
});

describe('assertUsablePdf', () => {
  it('accepts an ordinary document', () => {
    expect(() => assertUsablePdf({ pages: 3, encrypted: false } as never, LIMITS)).not.toThrow();
  });

  it('refuses an encrypted document with its own code', () => {
    try {
      assertUsablePdf({ pages: 1, encrypted: true } as never, LIMITS);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.PdfEncrypted);
    }
  });

  it('refuses a document past the page ceiling', () => {
    try {
      assertUsablePdf({ pages: 500, encrypted: false } as never, LIMITS);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.PdfTooManyPages);
    }
  });
});

describe('resolvePageRange', () => {
  it('defaults to the whole document', () => {
    expect(resolvePageRange(undefined, 7, 50)).toEqual({ first: 1, last: 7 });
  });

  it('accepts an explicit range inside the document', () => {
    expect(resolvePageRange({ first: 2, last: 4 }, 7, 50)).toEqual({ first: 2, last: 4 });
  });

  it('refuses a range past the end rather than clamping it', () => {
    // A user asking for pages 40-50 of a 10-page file has misunderstood
    // something, and silently returning pages 1-10 hides that.
    try {
      resolvePageRange({ first: 40, last: 50 }, 10, 50);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.InvalidPageRange);
    }
  });

  it('refuses an inverted range', () => {
    expect(() => resolvePageRange({ first: 5, last: 2 }, 10, 50)).toThrow();
  });

  it('refuses zero, negative and fractional page numbers', () => {
    for (const range of [{ first: 0 }, { first: -1 }, { first: 1.5 }, { last: 2.7 }]) {
      expect(() => resolvePageRange(range, 10, 50), JSON.stringify(range)).toThrow();
    }
  });

  it('refuses a range wider than the page ceiling', () => {
    try {
      resolvePageRange({ first: 1, last: 100 }, 200, 50);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.PdfTooManyPages);
    }
  });
});

describe('page file names', () => {
  it('pads so a listing sorts correctly', () => {
    // Without padding `page-10` sorts before `page-2`, and the pages reach the
    // user out of order — indistinguishable from corruption for a document.
    expect(pageFileName(2, 150, 'jpg')).toBe('page-002.jpg');
    expect(pageFileName(150, 150, 'jpg')).toBe('page-150.jpg');
    expect([pageFileName(10, 150, 'jpg'), pageFileName(2, 150, 'jpg')].sort()).toEqual([
      'page-002.jpg',
      'page-010.jpg',
    ]);
  });

  it('widens the padding for a very long document', () => {
    expect(pageNumberPadding(9)).toBe(3);
    expect(pageNumberPadding(1_000)).toBe(4);
    expect(pageFileName(7, 1_000, 'png')).toBe('page-0007.png');
  });
});

describe('buildPdftocairoArgs', () => {
  it('selects the format and passes the page bounds', () => {
    const args = buildPdftocairoArgs('in.pdf', '/tmp/out/page', {
      format: 'png',
      dpi: 150,
      range: { first: 2, last: 5 },
    });

    expect(args).toContain('-png');
    expect(args.join(' ')).toContain('-r 150');
    expect(args.join(' ')).toContain('-f 2');
    expect(args.join(' ')).toContain('-l 5');
  });

  it('sets a JPEG quality only for JPEG', () => {
    const jpeg = buildPdftocairoArgs('in.pdf', 'p', {
      format: 'jpeg',
      dpi: 150,
      range: { first: 1, last: 1 },
    });
    expect(jpeg.join(' ')).toContain('-jpegopt quality=88');

    const png = buildPdftocairoArgs('in.pdf', 'p', {
      format: 'png',
      dpi: 150,
      range: { first: 1, last: 1 },
    });
    expect(png.join(' ')).not.toContain('-jpegopt');
  });

  it('passes the output as a PREFIX, with no extension', () => {
    // Poppler appends `-1` and the extension itself. A full filename produces
    // `out.png-1.png`.
    const args = buildPdftocairoArgs('in.pdf', '/tmp/out/page', {
      format: 'png',
      dpi: 150,
      range: { first: 1, last: 1 },
    });
    expect(args[args.length - 1]).toBe('/tmp/out/page');
    expect(args[args.length - 1]).not.toContain('.png');
  });
});

describe('planImagePlacement', () => {
  it('matches the page to the image in image mode', () => {
    const placement = planImagePlacement(800, 600, 'image');
    expect(placement).toMatchObject({
      pageWidth: 800,
      pageHeight: 600,
      drawWidth: 800,
      drawHeight: 600,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('never stretches: width and height share one scale factor', () => {
    // Scaling the two axes independently is the one result nobody wants, and
    // it is what a naive implementation does.
    for (const mode of ['a4-contain', 'a4-cover'] as const) {
      const placement = planImagePlacement(1600, 900, mode);
      const scaleX = placement.drawWidth / 1600;
      const scaleY = placement.drawHeight / 900;
      expect(scaleX, mode).toBeCloseTo(scaleY, 6);
    }
  });

  it('fits the whole image inside the page for contain', () => {
    const placement = planImagePlacement(4000, 3000, 'a4-contain');
    expect(placement.drawWidth).toBeLessThanOrEqual(PAGE_SIZES.a4.width + 0.01);
    expect(placement.drawHeight).toBeLessThanOrEqual(PAGE_SIZES.a4.height + 0.01);
  });

  it('fills the page for cover, overflowing on one axis', () => {
    const placement = planImagePlacement(4000, 3000, 'a4-cover');
    expect(placement.drawWidth).toBeGreaterThanOrEqual(PAGE_SIZES.a4.width - 0.01);
    expect(placement.drawHeight).toBeGreaterThanOrEqual(PAGE_SIZES.a4.height - 0.01);
  });

  it('centres the image, so a cover crop is split evenly', () => {
    const placement = planImagePlacement(4000, 3000, 'a4-cover');
    expect(placement.offsetX * 2 + placement.drawWidth).toBeCloseTo(placement.pageWidth, 6);
    expect(placement.offsetY * 2 + placement.drawHeight).toBeCloseTo(placement.pageHeight, 6);
  });

  it('honours a margin by shrinking the drawable area', () => {
    const none = planImagePlacement(1000, 1000, 'a4-contain', 0);
    const wide = planImagePlacement(1000, 1000, 'a4-contain', 50);
    expect(wide.drawWidth).toBeLessThan(none.drawWidth);
    expect(wide.offsetX).toBeGreaterThanOrEqual(50 - 0.01);
  });

  it('refuses an image with no dimensions', () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [-1, 5],
    ] as const) {
      expect(() => planImagePlacement(w, h, 'a4-contain'), `${w}x${h}`).toThrow();
    }
  });
});
