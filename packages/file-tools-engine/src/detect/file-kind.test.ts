import { ToolErrorCode } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { isToolError } from '../errors/tool-error.js';
import { claimedKindOf, kindOfMimeType, resolveInputKind } from './file-kind.js';

function codeOf(error: unknown): string | undefined {
  return isToolError(error) ? error.code : undefined;
}

describe('kindOfMimeType', () => {
  it('reads the family off the top-level type', () => {
    expect(kindOfMimeType('image/png')).toBe('image');
    expect(kindOfMimeType('video/mp4')).toBe('video');
    expect(kindOfMimeType('application/pdf')).toBe('pdf');
  });

  it('treats the generic types as no claim at all', () => {
    // Telegram labels a great many perfectly ordinary documents
    // `application/octet-stream`. Reading that as a contradiction would reject
    // most of what users actually send.
    for (const generic of ['application/octet-stream', 'binary/octet-stream', '', undefined]) {
      expect(kindOfMimeType(generic), String(generic)).toBeUndefined();
    }
  });

  it('does not mistake an audio file for a video', () => {
    // They share neither a container nor a tool: asking to strip the audio
    // from an MP3 is not a thing that can succeed.
    expect(kindOfMimeType('audio/mpeg')).toBeUndefined();
  });
});

describe('claimedKindOf', () => {
  it('prefers the declared type over the filename', () => {
    // The mime type is what the sending client computed; the extension is what
    // the user typed. When they disagree the computed one is the better guess.
    expect(claimedKindOf('application/pdf', 'holiday.jpg')).toBe('pdf');
  });

  it('falls back to the extension when the type says nothing', () => {
    expect(claimedKindOf('application/octet-stream', 'report.pdf')).toBe('pdf');
    expect(claimedKindOf(undefined, 'photo.PNG')).toBe('image');
  });

  it('claims nothing from a filename with no usable extension', () => {
    for (const name of ['report', 'archive.zip', '.pdf.', undefined]) {
      expect(claimedKindOf(undefined, name), String(name)).toBeUndefined();
    }
  });

  it('is not fooled by an extension buried in the middle of a name', () => {
    // `invoice.pdf.exe` claims to be an executable, not a PDF.
    expect(claimedKindOf(undefined, 'invoice.pdf.exe')).toBeUndefined();
  });
});

describe('resolveInputKind', () => {
  it('accepts a file whose bytes are what the tool needs', () => {
    expect(resolveInputKind({ sniffedMimeType: 'image/jpeg', expected: 'image' }).mimeType).toBe(
      'image/jpeg',
    );
  });

  it('trusts the BYTES, not the label', () => {
    // The label is attacker-controlled and the bytes are not. A PNG announced
    // as a video is still a PNG, and the image tools can act on it.
    expect(
      resolveInputKind({
        sniffedMimeType: 'image/png',
        declaredMimeType: 'video/mp4',
        expected: 'image',
      }).mimeType,
    ).toBe('image/png');
  });

  it('calls a file that CLAIMED to be usable and is not a mismatch', () => {
    // The informative case: a .zip renamed to .pdf. "This file does not match
    // its extension" tells the user what to fix; "unsupported file type" sends
    // them looking for a format they believe they already used.
    try {
      resolveInputKind({
        sniffedMimeType: 'application/zip',
        declaredFileName: 'report.pdf',
        expected: 'pdf',
      });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.MimeMismatch);
    }
  });

  it('calls a file that never claimed otherwise merely unsupported', () => {
    // No contradiction to report: the user simply sent the wrong thing.
    try {
      resolveInputKind({ sniffedMimeType: 'application/zip', expected: 'pdf' });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.UnsupportedFileType);
    }
  });

  it('refuses a file with no recognisable signature at all', () => {
    try {
      resolveInputKind({ sniffedMimeType: undefined, expected: 'image' });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.UnsupportedFileType);
    }
  });

  it('never puts a user filename in the error context', () => {
    // Filenames reach logs, and a filename is attacker-controlled input that
    // has already been used once to lie about the contents.
    try {
      resolveInputKind({
        sniffedMimeType: 'application/zip',
        declaredFileName: 'my-secret-project-q4.pdf',
        expected: 'pdf',
      });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      const serialized = JSON.stringify(isToolError(error) ? error.context : {});
      expect(serialized).not.toContain('my-secret-project');
    }
  });

  it('is not retryable, whichever way it failed', () => {
    // A file does not become a different format on the second attempt, and the
    // worker is shared: a retry is capacity taken from a job that would work.
    for (const input of [
      { sniffedMimeType: 'application/zip', expected: 'pdf' } as const,
      { sniffedMimeType: undefined, expected: 'image' } as const,
    ]) {
      try {
        resolveInputKind(input);
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(isToolError(error) && error.retryable, JSON.stringify(input)).toBe(false);
      }
    }
  });
});
