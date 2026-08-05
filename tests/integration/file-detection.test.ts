import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolErrorCode,
  isToolError,
  resolveInputKind,
  sniffFileType,
} from '@tgtools/file-tools-engine';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Exercised against real bytes rather than a stubbed sniffer.
 *
 * The unit suite covers the DECISION — which error a mismatch produces — with
 * the sniffed type handed in. What it cannot cover is whether `file-type`
 * actually recognises the formats this bot receives, and that is the half that
 * breaks silently: a dependency bump that stopped detecting AVIF would leave
 * every AVIF upload rejected as "unsupported" with nothing in the log to say
 * the detector had changed.
 */

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'tgtools-detect-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeImage(name: string, format: 'png' | 'jpeg' | 'webp'): Promise<string> {
  const path = join(workDir, name);
  const image = sharp({
    create: { width: 8, height: 8, channels: 3, background: '#336699' },
  });
  const buffer =
    format === 'png'
      ? await image.png().toBuffer()
      : format === 'jpeg'
        ? await image.jpeg().toBuffer()
        : await image.webp().toBuffer();
  await writeFile(path, buffer);
  return path;
}

describe('sniffFileType', () => {
  it('recognises the raster formats the image tools accept', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const path = await writeImage(`sample.${format}`, format);
      expect(await sniffFileType(path), format).toBe(`image/${format}`);
    }
  });

  it('recognises a PDF', async () => {
    // A minimal but structurally real document; `%PDF-` is the signature.
    const path = join(workDir, 'doc.pdf');
    await writeFile(path, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    expect(await sniffFileType(path)).toBe('application/pdf');
  });

  it('reports nothing for a file with no signature', async () => {
    // Plain text has none. `undefined` rather than a throw, so the caller can
    // say what the file was SUPPOSED to be.
    const path = join(workDir, 'notes.txt');
    await writeFile(path, 'just some text, no magic bytes here');
    expect(await sniffFileType(path)).toBeUndefined();
  });

  it('reports nothing for a file that does not exist', async () => {
    // Unreadable and unrecognised are the same answer to the caller; the real
    // file-system error surfaces with better context at the first real read.
    expect(await sniffFileType(join(workDir, 'absent.png'))).toBeUndefined();
  });

  it('reads only the head of the file, whatever its size', async () => {
    // The input here may be a 2 GB video. Deciding whether to reject it must
    // not begin by reading all of it.
    const path = join(workDir, 'big.png');
    const header = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    // 40 MB of trailing rubbish: still a PNG by signature, and if the detector
    // read the whole file this test would be conspicuously slow.
    await writeFile(path, Buffer.concat([header, Buffer.alloc(40 * 1024 * 1024, 0x41)]));

    const started = Date.now();
    expect(await sniffFileType(path)).toBe('image/png');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('detection joined to the decision', () => {
  it('accepts a real image for an image tool', async () => {
    const path = await writeImage('photo.jpg', 'jpeg');
    const resolved = resolveInputKind({
      sniffedMimeType: await sniffFileType(path),
      expected: 'image',
      declaredMimeType: 'image/jpeg',
      declaredFileName: 'photo.jpg',
    });
    expect(resolved).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
  });

  it('catches a PNG wearing a .pdf extension', async () => {
    // The bug worth catching: without a signature check this reaches pdfinfo,
    // which fails with a parser message that reads like a broken PDF rather
    // than like the wrong file.
    const path = await writeImage('report.pdf', 'png');

    try {
      resolveInputKind({
        sniffedMimeType: await sniffFileType(path),
        expected: 'pdf',
        declaredMimeType: 'application/pdf',
        declaredFileName: 'report.pdf',
      });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(isToolError(error) && error.code).toBe(ToolErrorCode.MimeMismatch);
      expect(isToolError(error) && error.retryable).toBe(false);
    }
  });

  it('accepts an image whose declared type is the generic one', async () => {
    // Telegram labels a great many ordinary documents
    // `application/octet-stream`. Treating that as a contradiction would reject
    // most of what users actually send.
    const path = await writeImage('scan.png', 'png');
    expect(
      resolveInputKind({
        sniffedMimeType: await sniffFileType(path),
        expected: 'image',
        declaredMimeType: 'application/octet-stream',
        declaredFileName: 'scan.png',
      }).kind,
    ).toBe('image');
  });
});
