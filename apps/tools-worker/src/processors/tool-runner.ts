import type {
  FfmpegVideoProcessor,
  InputKind,
  NodeQrGenerator,
  PopplerPdfProcessor,
  SharpImageProcessor,
  ToolWorkspace,
} from '@tgtools/file-tools-engine';
import { ToolError, ToolErrorCode } from '@tgtools/file-tools-engine';
import { assertNever } from '@tgtools/shared';
import type { ToolOperation } from '@tgtools/tool-contracts';
import type { FetchedFile } from '../telegram/tool-file-fetcher.js';

/**
 * The eight tools, joined to the eight engine calls.
 *
 * Everything above this is transport — a queue message, a status edit, an
 * upload — and everything below it is a processor that knows nothing about
 * Telegram. This is the only place the two vocabularies meet, which is why the
 * switch is exhaustive and compiler-checked: a ninth tool added to the contract
 * cannot reach production without someone deciding what it runs.
 */

export interface ToolRunOutput {
  readonly path: string;
  /** Without the dot. Decides the extension the user's file arrives with. */
  readonly extension: string;
  /** Only for video, and only so clients show a player rather than a file row. */
  readonly durationSeconds?: number | undefined;
  /** For `pdf.to_images`, so the pages sort in reading order. */
  readonly pageNumber?: number | undefined;
  readonly pageCount?: number | undefined;
}

/**
 * Facts about what happened, NOT the sentence describing it.
 *
 * The processor renders these through `faTools`. Returning Persian from here
 * would put presentation inside the layer that runs ffmpeg.
 */
export type ToolRunSummary =
  | { readonly kind: 'compressed'; readonly originalBytes: number; readonly finalBytes: number }
  | { readonly kind: 'kept-original' }
  | { readonly kind: 'target-missed'; readonly targetBytes: number }
  | { readonly kind: 'pages'; readonly count: number };

export interface ToolRunResult {
  readonly outputs: readonly ToolRunOutput[];
  readonly summary: ToolRunSummary | undefined;
}

export interface ToolProcessors {
  readonly image: SharpImageProcessor;
  readonly video: FfmpegVideoProcessor;
  readonly pdf: PopplerPdfProcessor;
  readonly qr: NodeQrGenerator;
}

export interface ToolRunContext {
  readonly operation: ToolOperation;
  readonly inputs: readonly FetchedFile[];
  readonly workspace: ToolWorkspace;
  readonly processors: ToolProcessors;
  readonly signal: AbortSignal;
  readonly videoTimeoutMs: number;
  readonly onProgress: (fraction: number) => void;
}

/** Which kind of file each tool consumes. QR consumes none. */
export function expectedInputKind(tool: ToolOperation['tool']): InputKind | undefined {
  switch (tool) {
    case 'image.compress':
    case 'image.resize':
    case 'image.convert':
      // Building a PDF CONSUMES images even though it is queued as PDF work.
      return 'image';
    case 'pdf.images_to_pdf':
      return 'image';
    case 'video.extract_mp3':
    case 'video.remove_audio':
      return 'video';
    case 'pdf.to_images':
      return 'pdf';
    case 'qr.generate':
      return undefined;
    default:
      return assertNever(tool, 'tool key');
  }
}

/**
 * The extension a file of this type should carry.
 *
 * Derived from the SNIFFED type, so a video the user named `.mp4` that is
 * really a Matroska file comes back as `.mkv` — which is what will actually
 * play.
 */
function extensionForMime(mimeType: string): string {
  const known: Readonly<Record<string, string>> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/tiff': 'tiff',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/webm': 'webm',
    'video/x-msvideo': 'avi',
    'application/pdf': 'pdf',
  };
  return known[mimeType] ?? 'bin';
}

function firstInput(context: ToolRunContext): FetchedFile {
  const input = context.inputs[0];
  if (input === undefined) {
    // Guarded upstream by `expectedInputCount`, but a queue outlives a
    // deployment and this is cheaper than a crash inside Sharp.
    throw new ToolError(ToolErrorCode.InternalError, 'the tool ran with no input file');
  }
  return input;
}

export async function runTool(context: ToolRunContext): Promise<ToolRunResult> {
  const { operation, workspace, processors } = context;

  switch (operation.tool) {
    case 'image.compress': {
      const input = firstInput(context);
      const extension = extensionForMime(input.mimeType);
      const output = workspace.path('output', extension);
      const result = await processors.image.compress(input.path, output, {
        level: operation.level,
        ...(operation.targetBytes === undefined ? {} : { targetBytes: operation.targetBytes }),
      });

      return {
        outputs: [{ path: result.outputPath, extension: result.format }],
        summary: summariseCompression(result, input.sizeBytes, operation.targetBytes),
      };
    }

    case 'image.resize': {
      const input = firstInput(context);
      const output = workspace.path('output', extensionForMime(input.mimeType));
      const result = await processors.image.resize(input.path, output, {
        width: operation.width,
        ...(operation.height === undefined ? {} : { height: operation.height }),
        fit: operation.fit,
        ...(operation.background === undefined ? {} : { background: operation.background }),
        ...(operation.allowUpscale === undefined ? {} : { allowUpscale: operation.allowUpscale }),
      });
      return {
        outputs: [{ path: result.outputPath, extension: result.format }],
        summary: undefined,
      };
    }

    case 'image.convert': {
      const input = firstInput(context);
      const output = workspace.path(
        'output',
        operation.format === 'jpeg' ? 'jpg' : operation.format,
      );
      const result = await processors.image.convert(input.path, output, {
        format: operation.format,
        ...(operation.background === undefined ? {} : { background: operation.background }),
        ...(operation.quality === undefined ? {} : { quality: operation.quality }),
        ...(operation.lossless === undefined ? {} : { lossless: operation.lossless }),
      });
      return {
        outputs: [{ path: result.outputPath, extension: result.format }],
        summary: undefined,
      };
    }

    case 'video.extract_mp3': {
      const input = firstInput(context);
      const output = workspace.path('output', 'mp3');
      const result = await processors.video.extractMp3(
        input.path,
        output,
        { quality: operation.quality },
        {
          signal: context.signal,
          onProgress: context.onProgress,
          timeoutMs: context.videoTimeoutMs,
        },
      );
      return {
        outputs: [
          { path: result.outputPath, extension: 'mp3', durationSeconds: result.durationSeconds },
        ],
        summary: undefined,
      };
    }

    case 'video.remove_audio': {
      const input = firstInput(context);
      // The same container as the input: the video stream is copied, not
      // re-encoded, so putting an untouched Matroska stream into an `.mp4`
      // would produce a file that many players refuse.
      const extension = extensionForMime(input.mimeType);
      const output = workspace.path('output', extension);
      const result = await processors.video.removeAudio(input.path, output, {
        signal: context.signal,
        onProgress: context.onProgress,
        timeoutMs: context.videoTimeoutMs,
      });
      return {
        outputs: [{ path: result.outputPath, extension, durationSeconds: result.durationSeconds }],
        summary: undefined,
      };
    }

    case 'pdf.images_to_pdf': {
      const output = workspace.path('output', 'pdf');
      const result = await processors.pdf.fromImages(
        // Already ordered: the queue payload preserves the order the user sent,
        // and `input_order` preserves it through the database.
        context.inputs.map((input) => input.path),
        output,
        {
          mode: operation.mode,
          ...(operation.marginPoints === undefined ? {} : { marginPoints: operation.marginPoints }),
        },
      );
      return {
        outputs: [{ path: result.outputPath, extension: 'pdf' }],
        summary: { kind: 'pages', count: result.pages },
      };
    }

    case 'pdf.to_images': {
      const input = firstInput(context);
      const result = await processors.pdf.toImages(input.path, workspace.outputDir, {
        format: operation.format,
        dpi: operation.dpi,
        range: {
          ...(operation.firstPage === undefined ? {} : { first: operation.firstPage }),
          ...(operation.lastPage === undefined ? {} : { last: operation.lastPage }),
        },
      });

      const extension = operation.format === 'jpeg' ? 'jpg' : 'png';
      return {
        outputs: result.pagePaths.map((path, index) => ({
          path,
          extension,
          pageNumber: index + 1,
          pageCount: result.pagePaths.length,
        })),
        summary: { kind: 'pages', count: result.pagePaths.length },
      };
    }

    case 'qr.generate': {
      const output = workspace.path('output', operation.format);
      const result = await processors.qr.generate(operation.content, output, {
        format: operation.format,
        size: operation.size,
        errorCorrection: operation.errorCorrection,
      });
      return {
        outputs: [{ path: result.outputPath, extension: operation.format }],
        summary: undefined,
      };
    }

    default:
      return assertNever(operation, 'tool operation');
  }
}

/**
 * Which of the three things worth saying about a compression actually happened.
 *
 * `keptOriginal` is checked FIRST. When every attempt came out larger the
 * processor hands back the original, and reporting that as a 0% saving reads as
 * a bug rather than as the deliberate choice it is.
 */
function summariseCompression(
  result: {
    readonly sizeBytes: number;
    readonly keptOriginal?: boolean;
    readonly targetMissed?: boolean;
  },
  originalBytes: number,
  targetBytes: number | undefined,
): ToolRunSummary {
  if (result.keptOriginal === true) return { kind: 'kept-original' };
  if (result.targetMissed === true && targetBytes !== undefined) {
    return { kind: 'target-missed', targetBytes };
  }
  return { kind: 'compressed', originalBytes, finalBytes: result.sizeBytes };
}
