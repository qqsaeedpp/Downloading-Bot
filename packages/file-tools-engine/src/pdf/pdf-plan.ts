import { ToolError, ToolErrorCode } from '../errors/tool-error.js';

/**
 * Everything about the PDF tools that can be decided without running Poppler:
 * parsing `pdfinfo`, validating a page range, laying an image out on a page,
 * and building the `pdftocairo` argument vector.
 */

/** Page sizes offered in the menu, in PostScript points (72 per inch). */
export const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  a5: { width: 419.53, height: 595.28 },
} as const;
export type PageSizeKey = keyof typeof PAGE_SIZES;

export const PDF_PAGE_MODE_VALUES = ['image', 'a4-contain', 'a4-cover'] as const;
export type PdfPageMode = (typeof PDF_PAGE_MODE_VALUES)[number];

export interface PdfInfo {
  readonly pages: number;
  readonly encrypted: boolean;
  readonly firstPageWidth: number | undefined;
  readonly firstPageHeight: number | undefined;
}

/**
 * Parse `pdfinfo` output.
 *
 * Plain `key: value` text, not JSON — Poppler has no JSON mode — so this is a
 * line parser. Returns `undefined` when the page count is missing, which is how
 * a non-PDF or a corrupt one presents.
 */
export function parsePdfInfo(stdout: string): PdfInfo | undefined {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const pages = Number(fields.get('pages'));
  if (!Number.isInteger(pages) || pages <= 0) return undefined;

  // "Page size: 595.28 x 841.89 pts (A4)" — the numbers are what matter.
  const pageSize = fields.get('page size') ?? '';
  const match = /([\d.]+)\s*x\s*([\d.]+)/.exec(pageSize);

  return {
    pages,
    // Poppler prints "yes (print:no copy:no ...)" for an encrypted file, so an
    // equality test against "yes" misses it entirely.
    //
    // Inverted deliberately: anything that is not plainly "no" counts as
    // encrypted. Refusing a readable file is recoverable and the user is told
    // why; attempting an unreadable one spends the whole render to reach a
    // confusing failure. When unsure, the safe answer is "encrypted".
    encrypted: !(fields.get('encrypted') ?? 'no').toLowerCase().startsWith('no'),
    firstPageWidth: match === null ? undefined : Number(match[1]),
    firstPageHeight: match === null ? undefined : Number(match[2]),
  };
}

export interface PdfLimits {
  readonly maxPages: number;
  readonly maxImages: number;
  readonly maxInputBytes: number;
}

/** Refuse a PDF the tools will not process, before Poppler is started. */
export function assertUsablePdf(info: PdfInfo, limits: PdfLimits): void {
  if (info.encrypted) {
    throw new ToolError(ToolErrorCode.PdfEncrypted, 'PDF is encrypted');
  }
  if (info.pages > limits.maxPages) {
    throw new ToolError(ToolErrorCode.PdfTooManyPages, 'PDF has more pages than the ceiling', {
      context: { pages: info.pages, maxPages: limits.maxPages },
    });
  }
}

export interface PageRange {
  readonly first: number;
  readonly last: number;
}

/**
 * Validate a requested page range against the document.
 *
 * Every bound is checked rather than clamped. A user who asks for pages 40-50
 * of a 10-page file has misunderstood something, and silently returning pages
 * 1-10 hides that; the error is the useful answer.
 */
export function resolvePageRange(
  requested: Partial<PageRange> | undefined,
  totalPages: number,
  maxPages: number,
): PageRange {
  const first = requested?.first ?? 1;
  const last = requested?.last ?? totalPages;

  if (!Number.isInteger(first) || !Number.isInteger(last)) {
    throw new ToolError(ToolErrorCode.InvalidPageRange, 'page numbers must be whole numbers');
  }
  if (first < 1 || last < 1) {
    throw new ToolError(ToolErrorCode.InvalidPageRange, 'page numbers start at 1');
  }
  if (first > last) {
    throw new ToolError(ToolErrorCode.InvalidPageRange, 'the first page is after the last', {
      context: { first, last },
    });
  }
  if (first > totalPages || last > totalPages) {
    throw new ToolError(ToolErrorCode.InvalidPageRange, 'the range extends past the document', {
      context: { first, last, totalPages },
    });
  }
  if (last - first + 1 > maxPages) {
    throw new ToolError(ToolErrorCode.PdfTooManyPages, 'the range covers more pages than allowed', {
      context: { requested: last - first + 1, maxPages },
    });
  }

  return { first, last };
}

/**
 * How many digits page filenames need.
 *
 * Zero-padded so a directory listing sorts correctly: without it `page-10`
 * sorts before `page-2`, and the pages are then sent to the user out of order —
 * which for a document is indistinguishable from corruption.
 */
export function pageNumberPadding(totalPages: number): number {
  return Math.max(3, String(totalPages).length);
}

export function pageFileName(page: number, totalPages: number, extension: string): string {
  return `page-${String(page).padStart(pageNumberPadding(totalPages), '0')}.${extension}`;
}

export interface RenderOptions {
  readonly format: 'png' | 'jpeg';
  readonly dpi: number;
  readonly range: PageRange;
}

/**
 * The `pdftocairo` argument vector.
 *
 * The output argument is a PREFIX, not a filename: Poppler appends `-1`, `-2`
 * and the extension itself. Passing a full filename produces `out.png-1.png`,
 * which is the kind of thing that only shows up once real files exist.
 */
export function buildPdftocairoArgs(
  inputPath: string,
  outputPrefix: string,
  options: RenderOptions,
): string[] {
  return [
    options.format === 'png' ? '-png' : '-jpeg',
    ...(options.format === 'jpeg' ? ['-jpegopt', 'quality=88'] : []),
    '-r',
    String(options.dpi),
    '-f',
    String(options.range.first),
    '-l',
    String(options.range.last),
    inputPath,
    outputPrefix,
  ];
}

/** `pdfinfo` arguments. Kept beside the renderer so the CLI surface is in one place. */
export function buildPdfInfoArgs(inputPath: string): string[] {
  return [inputPath];
}

export interface ImagePlacement {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly drawWidth: number;
  readonly drawHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Where an image sits on its page.
 *
 * `image` mode makes the page match the picture, so nothing is cropped and no
 * margin appears. The A4 modes fit a fixed page: `contain` scales down until
 * the whole image fits and centres it, `cover` scales up until the page is
 * filled and lets the overflow crop.
 *
 * Neither ever stretches. Scaling width and height by different factors is the
 * one result nobody wants, and it is what a naive implementation does.
 */
export function planImagePlacement(
  imageWidth: number,
  imageHeight: number,
  mode: PdfPageMode,
  marginPoints = 0,
): ImagePlacement {
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new ToolError(ToolErrorCode.InvalidImage, 'image has no usable dimensions');
  }

  if (mode === 'image') {
    return {
      pageWidth: imageWidth,
      pageHeight: imageHeight,
      drawWidth: imageWidth,
      drawHeight: imageHeight,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const page = PAGE_SIZES.a4;
  const availableWidth = page.width - marginPoints * 2;
  const availableHeight = page.height - marginPoints * 2;

  // The single shared factor is what preserves the aspect ratio. `min` fits
  // inside; `max` fills and overflows.
  const scale =
    mode === 'a4-cover'
      ? Math.max(availableWidth / imageWidth, availableHeight / imageHeight)
      : Math.min(availableWidth / imageWidth, availableHeight / imageHeight);

  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;

  return {
    pageWidth: page.width,
    pageHeight: page.height,
    drawWidth,
    drawHeight,
    // Centred, which for `cover` means the overflow is split evenly rather than
    // all of it being taken off one edge.
    offsetX: (page.width - drawWidth) / 2,
    offsetY: (page.height - drawHeight) / 2,
  };
}
