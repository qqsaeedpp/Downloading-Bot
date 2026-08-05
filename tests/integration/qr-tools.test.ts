import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeQrGenerator, ToolErrorCode, isToolError } from '@tgtools/file-tools-engine';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Against the real `qrcode` encoder.
 *
 * Worth doing end to end because the payload tests prove the STRING is right
 * and prove nothing about whether it survives encoding — the byte ceiling that
 * matters is a property of the QR format at a given error-correction level, not
 * of our own limit.
 */
describe('QR generation', () => {
  let dir: string;
  let generator: NodeQrGenerator;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tgtools-qr-'));
    generator = new NodeQrGenerator({ maxPayloadBytes: 1_500 });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const options = { format: 'png', size: 512, errorCorrection: 'M' } as const;

  it('writes a real PNG at the requested size', async () => {
    const result = await generator.generate(
      { kind: 'text', text: 'hello' },
      join(dir, 'a.png'),
      options,
    );

    expect(result.sizeBytes).toBeGreaterThan(0);
    const meta = await sharp(result.outputPath).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('encodes Persian text, which is multi-byte', async () => {
    // The case a character-counting limit gets wrong.
    const result = await generator.generate(
      { kind: 'text', text: 'سلام دنیا — این یک آزمایش است' },
      join(dir, 'fa.png'),
      options,
    );
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('writes SVG as text, not as a binary blob', async () => {
    const result = await generator.generate(
      { kind: 'url', url: 'example.com' },
      join(dir, 'a.svg'),
      {
        ...options,
        format: 'svg',
      },
    );

    const content = await readFile(result.outputPath, 'utf8');
    expect(content.startsWith('<?xml') || content.startsWith('<svg')).toBe(true);
    expect(content).toContain('</svg>');
  });

  it('keeps a quiet zone, without which scanners fail', async () => {
    // Four modules of margin is what the specification requires, and a code
    // printed flush to an edge fails in a way that looks like a broken code.
    const result = await generator.generate(
      { kind: 'text', text: 'margin check' },
      join(dir, 'm.png'),
      options,
    );

    const { data, info } = await sharp(result.outputPath)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // The top-left corner must be white — the quiet zone, not a finder pattern.
    expect(data[0]).toBeGreaterThan(200);
    expect(info.width).toBe(512);
  });

  it('produces black on white, because inverting makes it unreadable', async () => {
    const result = await generator.generate(
      { kind: 'text', text: 'contrast' },
      join(dir, 'c.png'),
      options,
    );

    const { data } = await sharp(result.outputPath)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Reduced rather than spread: a 512x512 greyscale buffer is 262144 values,
    // and `Math.min(...values)` overflows the call stack at that size.
    let darkest = 255;
    let lightest = 0;
    for (const value of data) {
      if (value < darkest) darkest = value;
      if (value > lightest) lightest = value;
    }

    expect(darkest).toBeLessThan(60);
    expect(lightest).toBeGreaterThan(200);
  });

  it('refuses a payload past the configured ceiling', async () => {
    await expect(
      generator.generate({ kind: 'text', text: 'x'.repeat(2_000) }, join(dir, 'big.png'), options),
    ).rejects.toSatisfy((e: unknown) => isToolError(e) && e.code === ToolErrorCode.QrInputTooLong);
  });

  it('reports an encoder overflow as a length problem, not an internal error', async () => {
    // Our byte ceiling is not the same as the format's. At level H the capacity
    // is far smaller, and a payload that passes our check can still overflow —
    // which is still "too long" from the user's point of view.
    const permissive = new NodeQrGenerator({ maxPayloadBytes: 100_000 });

    await expect(
      permissive.generate({ kind: 'text', text: 'x'.repeat(5_000) }, join(dir, 'h.png'), {
        ...options,
        errorCorrection: 'H',
      }),
    ).rejects.toSatisfy((e: unknown) => isToolError(e) && e.code === ToolErrorCode.QrInputTooLong);
  });

  it('encodes every payload kind end to end', async () => {
    const inputs = [
      { kind: 'text', text: 'plain' },
      { kind: 'url', url: 'example.com' },
      { kind: 'wifi', ssid: 'Net;1', password: 'p;a:s,s', security: 'WPA' },
      { kind: 'phone', phone: '+98 912 345 6789' },
      { kind: 'email', email: 'a@b.test' },
      { kind: 'geo', latitude: 35.6892, longitude: 51.389 },
      { kind: 'vcard', name: 'Ali', phone: '+989123456789', email: 'a@b.test' },
    ] as const;

    for (const [index, input] of inputs.entries()) {
      const result = await generator.generate(
        input,
        join(dir, `kind-${String(index)}.png`),
        options,
      );
      expect(result.sizeBytes, input.kind).toBeGreaterThan(0);
    }
  });

  it('accepts every error-correction level offered', async () => {
    for (const level of ['M', 'Q', 'H'] as const) {
      const result = await generator.generate(
        { kind: 'text', text: 'level check' },
        join(dir, `ec-${level}.png`),
        { ...options, errorCorrection: level },
      );
      expect(result.sizeBytes, level).toBeGreaterThan(0);
    }
  });
});
