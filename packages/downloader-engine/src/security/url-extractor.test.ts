import { describe, expect, it } from 'vitest';
import { extractUrls, trimTrailingPunctuation } from './url-extractor.js';

describe('extractUrls', () => {
  it('finds a bare link', () => {
    expect(extractUrls('https://www.instagram.com/reel/abc').urls).toEqual([
      'https://www.instagram.com/reel/abc',
    ]);
  });

  it('finds a link embedded in a sentence', () => {
    const { urls } = extractUrls('ببین این چقدر خوبه https://vm.tiktok.com/ZMabc/ حتماً ببین');
    expect(urls).toEqual(['https://vm.tiktok.com/ZMabc/']);
  });

  it('drops the full stop that ended the sentence, not the URL', () => {
    expect(extractUrls('see https://x.com/a/status/1.').urls).toEqual(['https://x.com/a/status/1']);
  });

  it('keeps a closing paren that belongs to the path', () => {
    expect(trimTrailingPunctuation('https://example.test/a_(b)')).toBe(
      'https://example.test/a_(b)',
    );
  });

  it('drops a closing paren that closed the sentence', () => {
    // The matcher starts at `https://`, so the opening paren was never part of
    // what it captured — which is exactly how the two cases are told apart.
    expect(trimTrailingPunctuation('https://example.test/a)')).toBe('https://example.test/a');
  });

  it('strips sentence punctuation from a parenthesised link end to end', () => {
    expect(extractUrls('(see https://x.com/a/status/1)').urls).toEqual([
      'https://x.com/a/status/1',
    ]);
  });

  it('preserves first-seen order and de-duplicates', () => {
    const { urls } = extractUrls(
      'https://x.com/a/status/1 and https://x.com/b/status/2 and https://x.com/a/status/1',
    );
    expect(urls).toEqual(['https://x.com/a/status/1', 'https://x.com/b/status/2']);
  });

  it('flags a command so its argument is not mistaken for a download request', () => {
    // `/start https://…` is a deep link. Treating it as a download would fire on
    // every referral link.
    const result = extractUrls('/start https://t.me/somebot?start=ref123');
    expect(result.isCommand).toBe(true);
  });

  it('returns nothing for a message with no link', () => {
    expect(extractUrls('سلام، حالت چطوره؟').urls).toEqual([]);
  });

  it('ignores a bare domain with no scheme', () => {
    // Guessing a scheme would mean guessing intent; the guard would reject it
    // anyway, but with a worse message.
    expect(extractUrls('instagram.com/reel/abc').urls).toEqual([]);
  });

  it('does not swallow a following word into the URL', () => {
    const { urls } = extractUrls('https://x.com/a/status/1 مرسی');
    expect(urls).toEqual(['https://x.com/a/status/1']);
  });
});
