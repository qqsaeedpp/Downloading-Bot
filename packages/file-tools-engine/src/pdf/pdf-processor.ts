import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { ToolError, ToolErrorCode } from '../errors/tool-error.js';
import { runProcess, runProcessOrThrow } from '../process/child-process-runner.js';
import type { PageRange, PdfInfo, PdfLimits, PdfPageMode } from './pdf-plan.js';
import {
  assertUsablePdf,
  buildPdfInfoArgs,
  buildPdftocairoArgs,
  parsePdfInfo,
  planImagePlacement,
  resolvePageRange,
} from './pdf-plan.js';

/**
 * The PDF tools: images in, document out, and the reverse.
 *
 * Building uses PDFKit, which streams — a fifty-page document is never held in
 * memory whole. Rendering uses Poppler, because rasterising a PDF correctly
 * means implementing a PostScript-adjacent imaging model, and the alternatives
 * in JavaScript are either browser engines or incomplete.
 */

export interface ImagesToPdfOptions {
  readonly mode: PdfPageMode;
  /** Points. Only meaningful for the A4 modes. */
  readonly marginPoints?: number;
}

export interface PdfBuildResult {
  readonly outputPath: string;
  readonly pages: number;
  readonly sizeBytes: number;
}

export interface PdfRenderOptions {
  readonly format: 'png' | 'jpeg';
  readonly dpi: number;
  readonly range?: Partial<PageRange> | undefined;
}

export interface PdfRenderResult {
  readonly pagePaths: readonly string[];
  readonly totalBytes: number;
}

export interface PdfProcessorOptions {
  readonly pdfinfoPath: string;
  readonly pdftocairoPath: string;
  readonly limits: PdfLimits;
}

export class PopplerPdfProcessor {
  constructor(private readonly options: PdfProcessorOptions) {}

  async inspect(inputPath: string): Promise<PdfInfo> {
    const { size } = await stat(inputPath);
    if (size > this.options.limits.maxInputBytes) {
      throw new ToolError(ToolErrorCode.InputTooLarge, 'PDF is larger than the input ceiling', {
        context: { sizeBytes: size, maxBytes: this.options.limits.maxInputBytes },
      });
    }

    const result = await runProcess({
      command: this.options.pdfinfoPath,
      args: buildPdfInfoArgs(inputPath),
      cwd: dirname(inputPath),
      timeoutMs: 30_000,
    });

    // pdfinfo exits non-zero for an encrypted file as well as a broken one, so
    // the OUTPUT is parsed first — an encrypted PDF has a specific message and
    // deserves a specific error.
    const info = parsePdfInfo(result.stdout);
    if (info === undefined) {
      const encrypted = /encrypt/i.test(result.stderr);
      throw new ToolError(
        encrypted ? ToolErrorCode.PdfEncrypted : ToolErrorCode.InvalidPdf,
        encrypted ? 'PDF is encrypted' : 'file is not a readable PDF',
        { context: { exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) } },
      );
    }
    return info;
  }

  /**
   * Render pages to images.
   *
   * Poppler writes `<prefix>-1.png`, `<prefix>-2.png` and so on, so the output
   * files are DISCOVERED afterwards rather than predicted. Predicting them
   * means assuming Poppler's padding rules, which differ between versions.
   */
  async toImages(
    inputPath: string,
    outputDir: string,
    options: PdfRenderOptions,
  ): Promise<PdfRenderResult> {
    const info = await this.inspect(inputPath);
    assertUsablePdf(info, this.options.limits);

    const range = resolvePageRange(options.range, info.pages, this.options.limits.maxPages);
    const prefix = join(outputDir, 'page');

    await runProcessOrThrow({
      command: this.options.pdftocairoPath,
      args: buildPdftocairoArgs(inputPath, prefix, { ...options, range }),
      cwd: outputDir,
      timeoutMs: 300_000,
    });

    const produced = (await readdir(outputDir))
      .filter((name) => name.startsWith('page-'))
      // Numeric sort on the page number. A lexicographic sort puts page 10
      // before page 2, and the user receives their document shuffled.
      .sort((a, b) => pageNumberOf(a) - pageNumberOf(b))
      .map((name) => join(outputDir, name));

    if (produced.length === 0) {
      throw new ToolError(ToolErrorCode.ExternalToolFailed, 'pdftocairo produced no pages');
    }

    let totalBytes = 0;
    for (const path of produced) totalBytes += (await stat(path)).size;

    return { pagePaths: produced, totalBytes };
  }

  /**
   * Build a PDF from images, one page each.
   *
   * Every image passes through Sharp first: WebP and AVIF are formats PDFKit
   * cannot embed, orientation has to be baked in before the dimensions are
   * measured, and alpha has to be flattened because PDF pages have no
   * transparency to composite onto.
   */
  async fromImages(
    imagePaths: readonly string[],
    outputPath: string,
    options: ImagesToPdfOptions,
  ): Promise<PdfBuildResult> {
    if (imagePaths.length === 0) {
      throw new ToolError(ToolErrorCode.InvalidImage, 'no images to build a PDF from');
    }
    if (imagePaths.length > this.options.limits.maxImages) {
      throw new ToolError(ToolErrorCode.PdfTooManyPages, 'more images than the ceiling allows', {
        context: { count: imagePaths.length, maxImages: this.options.limits.maxImages },
      });
    }

    // `autoFirstPage: false` because the first page's size depends on the first
    // image, which has not been read yet. Left on, every document starts with a
    // blank A4.
    const document = new PDFDocument({ autoFirstPage: false });
    const written = pipeline(document, createWriteStream(outputPath));

    try {
      for (const imagePath of imagePaths) {
        // Sequential on purpose. Decoding fifty images at once to build one
        // document is how a worker with a modest memory limit dies.
        const { data, info } = await sharp(imagePath)
          .rotate()
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .jpeg({ quality: 88 })
          .toBuffer({ resolveWithObject: true });

        const placement = planImagePlacement(
          info.width,
          info.height,
          options.mode,
          options.marginPoints ?? 0,
        );

        document.addPage({ size: [placement.pageWidth, placement.pageHeight] });
        document.image(data, placement.offsetX, placement.offsetY, {
          width: placement.drawWidth,
          height: placement.drawHeight,
        });
      }
      document.end();
      await written;
    } catch (error: unknown) {
      // Destroy the stream so the half-written file cannot be mistaken for a
      // result by anything downstream.
      document.destroy();
      // Destroying makes `pipeline` reject with ERR_STREAM_PREMATURE_CLOSE.
      // That rejection is expected and must be consumed here: unawaited it
      // becomes an unhandled rejection, which this worker treats as fatal — so
      // one unreadable image would take the whole process down instead of
      // failing one job.
      await written.catch(() => undefined);
      throw error;
    }

    const { size } = await stat(outputPath);
    if (size === 0) {
      throw new ToolError(ToolErrorCode.InternalError, 'PDF generation produced an empty file');
    }

    return { outputPath, pages: imagePaths.length, sizeBytes: size };
  }
}

/** The number out of `page-007.png`, for a numeric sort. */
function pageNumberOf(fileName: string): number {
  const match = /page-(\d+)/.exec(fileName);
  return match === null ? 0 : Number(match[1]);
}
