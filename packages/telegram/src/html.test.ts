import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_CAPTION_MAX_LENGTH,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  clampCaption,
  clampMessage,
  clampText,
  escapeHtml,
} from './html.js';

describe('escapeHtml', () => {
  it('escapes the four characters Telegram HTML mode cares about', () => {
    expect(escapeHtml('<b>Tom & "Jerry"</b>')).toBe(
      '&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;',
    );
  });

  it('escapes the ampersand first so escapes are not escaped twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves a single quote alone, which Telegram does not require escaped', () => {
    expect(escapeHtml("it's fine")).toBe("it's fine");
  });

  it('passes through text with nothing to escape, including non-Latin scripts', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('ویدیو 🎬')).toBe('ویدیو 🎬');
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeHtml('a<b<c')).toBe('a&lt;b&lt;c');
  });
});

describe('clampText', () => {
  it('returns the value unchanged when it is within the limit', () => {
    expect(clampText('hello', 10)).toBe('hello');
  });

  it('returns the value unchanged when it is exactly at the limit', () => {
    expect(clampText('hello', 5)).toBe('hello');
  });

  it('appends an ellipsis and never exceeds the limit', () => {
    const result = clampText('abcdefghij', 5);

    expect(result).toBe('abcd…');
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('drops a half-written HTML entity rather than emitting a dangling ampersand', () => {
    // slice(0, 9) lands inside "&amp;", leaving "aaaaaaa&a".
    const result = clampText('aaaaaaa&amp;bbbb', 10);

    expect(result).toBe('aaaaaaa…');
    expect(result).not.toContain('&');
  });

  it('keeps an entity that is complete at the cut point', () => {
    const result = clampText(`&amp;${'b'.repeat(20)}`, 10);

    expect(result).toBe('&amp;bbbb…');
    expect(result).toContain('&amp;');
  });

  it('only discards the last entity, keeping earlier complete ones', () => {
    const result = clampText('&amp;xyz&quot;more text here', 12);

    expect(result).toBe('&amp;xyz…');
    expect(result.split('&')).toHaveLength(2);
  });

  it('trims whitespace left at the cut before adding the ellipsis', () => {
    expect(clampText('hello   world', 7)).toBe('hello…');
  });

  it('produces output whose length never exceeds the limit for arbitrary cut points', () => {
    const value = `${'a'.repeat(50)}&amp;${'b'.repeat(50)}`;
    for (let limit = 2; limit <= 60; limit += 1) {
      const result = clampText(value, limit);
      expect(result.length).toBeLessThanOrEqual(limit);
      expect(/&[a-z]*$/.test(result.replace('…', ''))).toBe(false);
    }
  });
});

describe('clampCaption and clampMessage', () => {
  it('expose Telegram’s documented hard limits', () => {
    expect(TELEGRAM_CAPTION_MAX_LENGTH).toBe(1024);
    expect(TELEGRAM_MESSAGE_MAX_LENGTH).toBe(4096);
  });

  it('leaves a short caption alone', () => {
    expect(clampCaption('a tidy caption')).toBe('a tidy caption');
  });

  it('clamps an oversized caption to the caption limit', () => {
    const result = clampCaption('a'.repeat(2_000));

    expect(result).toHaveLength(TELEGRAM_CAPTION_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });

  it('clamps an oversized message to the message limit', () => {
    const result = clampMessage('a'.repeat(5_000));

    expect(result).toHaveLength(TELEGRAM_MESSAGE_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves a message that is exactly at the message limit intact', () => {
    const exact = 'a'.repeat(TELEGRAM_MESSAGE_MAX_LENGTH);

    expect(clampMessage(exact)).toBe(exact);
  });

  it('does not cut an escaped caption mid-entity', () => {
    const escaped = escapeHtml(`${'a'.repeat(TELEGRAM_CAPTION_MAX_LENGTH - 2)}&${'b'.repeat(50)}`);
    const result = clampCaption(escaped);

    expect(result).not.toMatch(/&[a-z]*$/);
    expect(result.endsWith('…')).toBe(true);
  });
});
