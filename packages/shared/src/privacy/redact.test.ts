import { describe, expect, it } from 'vitest';
import { hashUrl, redactUrl, stripUrlQuery, truncateForStorage } from './redact.js';

describe('redactUrl', () => {
  it('replaces the whole query string with a parameter count', () => {
    expect(redactUrl('https://cdn.example.com/v/clip.mp4?sig=SECRET&exp=1712345678')).toBe(
      'https://cdn.example.com/v/clip.mp4?<2 params>',
    );
  });

  it('leaks neither parameter names nor parameter values', () => {
    const redacted = redactUrl('https://cdn.example.com/v/clip.mp4?token=hunter2&session=abc123');

    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('token');
    expect(redacted).not.toContain('session');
  });

  it('counts repeated keys separately, as searchParams does', () => {
    expect(redactUrl('https://example.com/a?x=1&x=2&y=3')).toBe('https://example.com/a?<3 params>');
  });

  it('omits the query marker entirely when there is no query string', () => {
    expect(redactUrl('https://example.com/a/b')).toBe('https://example.com/a/b');
  });

  it('drops the fragment, which can carry a token of its own', () => {
    expect(redactUrl('https://example.com/a#access_token=SECRET')).toBe('https://example.com/a');
  });

  it('masks embedded credentials instead of echoing them', () => {
    const redacted = redactUrl('https://alice:hunter2@example.com/private/clip.mp4');

    expect(redacted).toBe('https://<credentials>@example.com/private/clip.mp4');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('alice');
  });

  it('masks a username even when there is no password', () => {
    expect(redactUrl('https://alice@example.com/x')).toBe('https://<credentials>@example.com/x');
  });

  it('keeps the port, which is part of the host and not a secret', () => {
    expect(redactUrl('http://localhost:8081/bot/file')).toBe('http://localhost:8081/bot/file');
  });

  it('returns a placeholder for anything that is not a URL', () => {
    expect(redactUrl('definitely not a url')).toBe('<unparsable-url>');
    expect(redactUrl('')).toBe('<unparsable-url>');
  });
});

describe('stripUrlQuery', () => {
  it('keeps origin and path while dropping the query and fragment', () => {
    expect(stripUrlQuery('https://example.com/p/CxYz/?igsh=SECRET#frag')).toBe(
      'https://example.com/p/CxYz/',
    );
  });

  it('strips embedded credentials', () => {
    expect(stripUrlQuery('https://alice:hunter2@example.com/a?b=c')).toBe('https://example.com/a');
  });

  it('leaves a URL that has nothing to strip unchanged', () => {
    expect(stripUrlQuery('https://example.com/a/b')).toBe('https://example.com/a/b');
  });

  it('returns the raw input when it cannot be parsed', () => {
    expect(stripUrlQuery('not-a-url')).toBe('not-a-url');
  });

  it('never returns a string containing the original query values', () => {
    const stripped = stripUrlQuery('https://cdn.example.com/x.mp4?policy=BASE64SIGNATURE');

    expect(stripped).not.toContain('BASE64SIGNATURE');
    expect(stripped).not.toContain('?');
  });
});

describe('hashUrl', () => {
  it('produces a 64-character lowercase hex digest', () => {
    expect(hashUrl('https://example.com/a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls for the same input', () => {
    expect(hashUrl('https://example.com/a')).toBe(hashUrl('https://example.com/a'));
  });

  it('is SHA-256 of the UTF-8 bytes', () => {
    expect(hashUrl('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('differs for inputs that differ only slightly', () => {
    expect(hashUrl('https://example.com/a')).not.toBe(hashUrl('https://example.com/b'));
    expect(hashUrl('https://example.com/a')).not.toBe(hashUrl('https://example.com/a/'));
  });

  it('does not embed the input it hashed', () => {
    expect(hashUrl('https://example.com/secret')).not.toContain('example');
  });
});

describe('truncateForStorage', () => {
  it('collapses runs of whitespace, including newlines and tabs', () => {
    expect(truncateForStorage('ERROR:\n\n  yt-dlp\t failed  ')).toBe('ERROR: yt-dlp failed');
  });

  it('leaves a short message otherwise untouched', () => {
    expect(truncateForStorage('boom')).toBe('boom');
  });

  it('keeps a message that is exactly at the limit', () => {
    expect(truncateForStorage('abcde', 5)).toBe('abcde');
  });

  it('caps a long message at maxLength characters including the ellipsis', () => {
    const result = truncateForStorage('x'.repeat(2_000));

    expect(result).toHaveLength(500);
    expect(result.endsWith('…')).toBe(true);
  });

  it('honours a caller-supplied maxLength', () => {
    expect(truncateForStorage('abcdef', 3)).toBe('ab…');
  });

  it('measures the limit after whitespace collapsing, not before', () => {
    const padded = `${'a'.repeat(10)}${' '.repeat(100)}${'b'.repeat(10)}`;

    expect(truncateForStorage(padded, 100)).toBe(`${'a'.repeat(10)} ${'b'.repeat(10)}`);
  });
});
