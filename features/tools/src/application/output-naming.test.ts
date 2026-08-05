import { ALL_TOOL_KEYS, ToolKey } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { outputFileName } from './output-naming.js';

describe('outputFileName', () => {
  it('names the result after the file the user sent', () => {
    // The user is about to receive this back in a chat that already contains
    // the original. A generated name makes the pair impossible to match up.
    expect(
      outputFileName({ tool: ToolKey.ImageCompress, extension: 'jpg', sourceName: 'beach.jpg' }),
    ).toBe('beach.jpg');
  });

  it('rewrites the extension to match what was actually produced', () => {
    // Keeping `.png` on a file that is now WebP makes Telegram show the wrong
    // icon and makes some clients refuse to open it at all.
    expect(
      outputFileName({ tool: ToolKey.ImageConvert, extension: 'webp', sourceName: 'logo.png' }),
    ).toBe('logo.webp');
  });

  it('marks a muted video so it cannot be confused with the original', () => {
    // Same name, same extension, silently different content — in the same chat
    // as the file it came from.
    const name = outputFileName({
      tool: ToolKey.VideoRemoveAudio,
      extension: 'mp4',
      sourceName: 'clip.mp4',
    });
    expect(name).not.toBe('clip.mp4');
    expect(name).toContain('clip');
    expect(name.endsWith('.mp4')).toBe(true);
  });

  it('strips path syntax out of a name the user controls', () => {
    // A Telegram filename is attacker-controlled input. It never builds a path
    // here — the workspace generates those — but it IS handed to Telegram as
    // `filename`, and it must not be able to carry a separator.
    const name = outputFileName({
      tool: ToolKey.ImageCompress,
      extension: 'jpg',
      sourceName: '../../etc/passwd',
    });
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('..');
  });

  it('falls back to a sensible name when the source had none', () => {
    // Photos sent from a phone camera arrive with no filename at all.
    const name = outputFileName({ tool: ToolKey.ImageCompress, extension: 'jpg' });
    expect(name).toMatch(/\.jpg$/);
    expect(name.length).toBeGreaterThan(4);
  });

  it('names a QR code without reference to anything the user typed', () => {
    // The content may be a Wi-Fi password. A filename derived from it would
    // put that password in a chat, a notification preview and a download folder.
    const name = outputFileName({
      tool: ToolKey.QrGenerate,
      extension: 'png',
      sourceName: 'hunter2-wifi-key',
    });
    expect(name).not.toContain('hunter2');
    expect(name.endsWith('.png')).toBe(true);
  });

  it('numbers rendered pages so they sort in reading order', () => {
    // Lexicographic sorting puts page 10 before page 2 in every file manager
    // the user might open the folder with.
    const first = outputFileName({
      tool: ToolKey.PdfToImages,
      extension: 'png',
      sourceName: 'report.pdf',
      pageNumber: 2,
      pageCount: 12,
    });
    const second = outputFileName({
      tool: ToolKey.PdfToImages,
      extension: 'png',
      sourceName: 'report.pdf',
      pageNumber: 10,
      pageCount: 12,
    });

    expect([second, first].sort()).toEqual([first, second]);
  });

  it('bounds the length, however long the original was', () => {
    // ext4 caps a name at 255 BYTES, and Persian is two to three bytes per
    // character — so a limit counted in characters would still overflow.
    const name = outputFileName({
      tool: ToolKey.ImageCompress,
      extension: 'jpg',
      sourceName: `${'س'.repeat(400)}.jpg`,
    });
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('produces a usable name for every tool in the vocabulary', () => {
    for (const tool of ALL_TOOL_KEYS) {
      const name = outputFileName({ tool, extension: 'bin', sourceName: 'input.dat' });
      expect(name, tool).toBeTruthy();
      expect(name, tool).not.toContain('undefined');
      expect(name.includes('/'), tool).toBe(false);
    }
  });
});
