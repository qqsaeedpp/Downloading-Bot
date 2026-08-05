import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { ToolError, ToolErrorCode } from '../errors/tool-error.js';
import type { QrInput } from './qr-payload.js';
import { assertPayloadFits, buildQrPayload } from './qr-payload.js';

/**
 * Renders a payload to an image. Everything it DECIDES lives in `qr-payload.ts`.
 *
 * Nothing here reaches the network. Several popular QR "libraries" are thin
 * wrappers around a hosted API, which would mean posting the user's Wi-Fi
 * password to a third party; `qrcode` renders locally, which is the reason it
 * was chosen.
 */

export const QR_OUTPUT_FORMAT_VALUES = ['png', 'svg'] as const;
export type QrOutputFormat = (typeof QR_OUTPUT_FORMAT_VALUES)[number];

export const QR_ERROR_CORRECTION_VALUES = ['M', 'Q', 'H'] as const;
export type QrErrorCorrection = (typeof QR_ERROR_CORRECTION_VALUES)[number];

export interface QrGenerateOptions {
  readonly format: QrOutputFormat;
  readonly size: number;
  /**
   * Higher levels survive damage and obstruction at the cost of capacity.
   *
   * `M` (~15%) is the default because it is what most printed codes use and it
   * leaves the most room for content. `L` is deliberately not offered: it looks
   * fine on screen and fails on paper.
   */
  readonly errorCorrection: QrErrorCorrection;
}

export interface QrResult {
  readonly outputPath: string;
  readonly format: QrOutputFormat;
  readonly sizeBytes: number;
}

export interface QrGenerator {
  generate(input: QrInput, outputPath: string, options: QrGenerateOptions): Promise<QrResult>;
}

export interface NodeQrGeneratorOptions {
  readonly maxPayloadBytes: number;
}

export class NodeQrGenerator implements QrGenerator {
  constructor(private readonly options: NodeQrGeneratorOptions) {}

  async generate(
    input: QrInput,
    outputPath: string,
    options: QrGenerateOptions,
  ): Promise<QrResult> {
    const payload = buildQrPayload(input);
    assertPayloadFits(payload, this.options.maxPayloadBytes);

    // Four modules of quiet zone is what the specification requires. Scanners
    // fail on codes printed flush to an edge, and the failure looks like a
    // broken code rather than a missing margin.
    const common = {
      errorCorrectionLevel: options.errorCorrection,
      margin: 4,
      // Black on white, explicitly. The defaults are already this, but a
      // contrast inversion is the single easiest way to make a code
      // unreadable, so it is stated rather than assumed.
      color: { dark: '#000000ff', light: '#ffffffff' },
    } as const;

    try {
      if (options.format === 'svg') {
        const svg = await QRCode.toString(payload, { ...common, type: 'svg', width: options.size });
        await writeFile(outputPath, svg, 'utf8');
      } else {
        await QRCode.toFile(outputPath, payload, {
          ...common,
          type: 'png',
          width: options.size,
        });
      }
    } catch (error: unknown) {
      // The usual cause is a payload too large for even version 40 at the
      // chosen correction level — the byte check above catches most of it, but
      // the exact ceiling depends on the correction level and the character set.
      throw new ToolError(ToolErrorCode.QrInputTooLong, 'QR payload could not be encoded', {
        cause: error,
        context: { errorCorrection: options.errorCorrection },
      });
    }

    const { size } = await import('node:fs/promises').then(async (fs) => await fs.stat(outputPath));
    if (size === 0) {
      throw new ToolError(ToolErrorCode.InternalError, 'QR generation produced an empty file');
    }

    return { outputPath, format: options.format, sizeBytes: size };
  }
}
