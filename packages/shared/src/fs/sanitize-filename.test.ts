import { describe, expect, it } from 'vitest';
import { sanitizeFilename, truncateToBytes } from './sanitize-filename.js';

/** True when the string survives a UTF-8 round trip, i.e. holds no lone surrogate. */
function isValidUtf8(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value && !value.includes('�');
}

describe('sanitizeFilename', () => {
  it('collapses a traversal payload down to its last segment so no separator survives', () => {
    const result = sanitizeFilename('../../etc/passwd');

    expect(result.name).toBe('passwd');
    expect(result.name).not.toContain('/');
    expect(result.name).not.toContain('\\');
    expect(result.name).not.toBe('..');
  });

  it('takes the last segment of a Windows-shaped path too', () => {
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.exe').name).toBe('evil.exe');
  });

  it('returns the fallback when the input is nothing but dot segments', () => {
    expect(sanitizeFilename('..').name).toBe('media');
    expect(sanitizeFilename('.').name).toBe('media');
  });

  it('replaces the Windows reserved device name "con" with the fallback', () => {
    expect(sanitizeFilename('con').name).toBe('media');
  });

  it('treats a reserved name as reserved regardless of case, e.g. "NUL"', () => {
    expect(sanitizeFilename('NUL').name).toBe('media');
  });

  it('still refuses a reserved base when an extension is attached, keeping the extension', () => {
    const result = sanitizeFilename('con.txt');

    expect(result.base).toBe('media');
    expect(result.extension).toBe('.txt');
    expect(result.name).toBe('media.txt');
  });

  it('removes every character Windows refuses: <>:"/\\|?*', () => {
    const result = sanitizeFilename('a<b>c:d"e|f?g*h.mp4');

    expect(result.name).toBe('a b c d e f g h.mp4');
    expect(result.name).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('strips leading and trailing dots and spaces, which Windows would drop silently', () => {
    const result = sanitizeFilename('  ...holiday clip...  ');

    expect(result.name).toBe('holiday clip');
    expect(result.name.startsWith('.')).toBe(false);
    expect(result.name.endsWith('.')).toBe(false);
    expect(result.name.trim()).toBe(result.name);
  });

  it('preserves a recognisable extension and lowercases it', () => {
    const result = sanitizeFilename('My Video.MP4');

    expect(result.base).toBe('My Video');
    expect(result.extension).toBe('.mp4');
    expect(result.name).toBe('My Video.mp4');
  });

  it('does not mistake a trailing word for an extension', () => {
    const result = sanitizeFilename('My Video.Best moment');

    expect(result.extension).toBe('');
    expect(result.base).toBe('My Video.Best moment');
    expect(result.name).toBe('My Video.Best moment');
  });

  it('does not treat a leading dot as an extension once the dot has been stripped', () => {
    const result = sanitizeFilename('.mp4');

    expect(result.name).toBe('mp4');
    expect(result.extension).toBe('');
  });

  it('caps the whole name at maxBytes, reserving room for the extension', () => {
    const result = sanitizeFilename(`${'a'.repeat(200)}.mp4`, { maxBytes: 20 });

    expect(Buffer.byteLength(result.name, 'utf8')).toBeLessThanOrEqual(20);
    expect(result.extension).toBe('.mp4');
    expect(result.base).toBe('a'.repeat(16));
  });

  it('counts bytes rather than characters for Persian text and stays valid UTF-8', () => {
    const result = sanitizeFilename('سلام دنیا سلام دنیا', { maxBytes: 10 });

    expect(Buffer.byteLength(result.name, 'utf8')).toBeLessThanOrEqual(10);
    expect(result.name).toBe('سلام');
    expect(isValidUtf8(result.name)).toBe(true);
  });

  it('never splits a 4-byte emoji in half when the byte cap falls mid-character', () => {
    const result = sanitizeFilename('🎬🎬🎬', { maxBytes: 9 });

    expect(result.name).toBe('🎬🎬');
    expect(Buffer.byteLength(result.name, 'utf8')).toBe(8);
    expect(isValidUtf8(result.name)).toBe(true);
  });

  it('returns the fallback for an empty input', () => {
    expect(sanitizeFilename('').name).toBe('media');
  });

  it('returns the fallback for whitespace-only input', () => {
    expect(sanitizeFilename('   \t  ').name).toBe('media');
  });

  it('honours a caller-supplied fallback', () => {
    expect(sanitizeFilename('   ', { fallback: 'clip' }).name).toBe('clip');
  });

  it('drops zero-width and bidi-override code points that could disguise the name', () => {
    const result = sanitizeFilename('rep‮gnp.jpg');

    expect(result.name).toBe('repgnp.jpg');
    expect(result.name).not.toContain('‮');
  });

  it('reports base and extension that recombine into the returned name', () => {
    const result = sanitizeFilename('Trip to Shiraz.MOV');

    expect(`${result.base}${result.extension}`).toBe(result.name);
  });
});

describe('truncateToBytes', () => {
  it('returns the value untouched when it already fits', () => {
    expect(truncateToBytes('hello', 100)).toBe('hello');
  });

  it('cuts on a character boundary rather than a byte boundary', () => {
    const result = truncateToBytes('héllo', 2);

    expect(result).toBe('h');
    expect(isValidUtf8(result)).toBe(true);
  });

  it('keeps multi-byte Persian characters whole', () => {
    const result = truncateToBytes('سلام', 5);

    expect(result).toBe('سل');
    expect(Buffer.byteLength(result, 'utf8')).toBe(4);
    expect(isValidUtf8(result)).toBe(true);
  });

  it('never emits half of a surrogate pair', () => {
    const result = truncateToBytes('🎬🎬', 6);

    expect(result).toBe('🎬');
    expect(isValidUtf8(result)).toBe(true);
  });

  it('trims trailing dots and spaces left behind by the cut', () => {
    expect(truncateToBytes('ab. ', 3)).toBe('ab');
  });

  it('returns an empty string when not even one character fits', () => {
    expect(truncateToBytes('🎬', 1)).toBe('');
  });
});
