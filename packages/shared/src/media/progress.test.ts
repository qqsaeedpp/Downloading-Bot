import { describe, expect, it } from 'vitest';
import { normalizeProgress } from './progress.js';

describe('normalizeProgress', () => {
  it('floors a fractional total to an integer', () => {
    // The bug that crashed a worker: yt-dlp reported
    // total_bytes = 1492973.3333333335 for a Pinterest video, and Postgres
    // refused the fractional value for a bigint column.
    const normalized = normalizeProgress({
      downloadedBytes: 222452,
      totalBytes: 1492973.3333333335,
    });

    expect(normalized.totalBytes).toBe(1492973);
    expect(Number.isInteger(normalized.totalBytes)).toBe(true);
  });

  it('floors a fractional downloaded count too', () => {
    expect(normalizeProgress({ downloadedBytes: 42.9 }).downloadedBytes).toBe(42);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('treats a %s downloaded count as zero rather than passing it on', (_label, value) => {
    expect(normalizeProgress({ downloadedBytes: value }).downloadedBytes).toBe(0);
  });

  it('clamps a negative byte count to zero', () => {
    expect(normalizeProgress({ downloadedBytes: -5 }).downloadedBytes).toBe(0);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative total', -1],
    ['zero', 0],
  ])('drops %s as an unknown total rather than storing nonsense', (_label, value) => {
    // `undefined` is a legitimate answer: Instagram and TikTok routinely report
    // no total at all.
    expect(normalizeProgress({ downloadedBytes: 1, totalBytes: value }).totalBytes).toBeUndefined();
  });

  it('keeps an unknown total unknown', () => {
    expect(normalizeProgress({ downloadedBytes: 1 }).totalBytes).toBeUndefined();
  });

  it('derives the percentage from the byte counts, not from the reported one', () => {
    // yt-dlp's own percentage disagrees with its byte counts often enough that
    // trusting the two independently produces a bar that jumps around.
    const normalized = normalizeProgress({
      downloadedBytes: 50,
      totalBytes: 200,
      percent: 99,
    });
    expect(normalized.percent).toBe(25);
  });

  it('falls back to the reported percentage when no total is known', () => {
    expect(normalizeProgress({ downloadedBytes: 10, percent: 37.6 }).percent).toBe(38);
  });

  it.each([
    [-10, 0],
    [150, 100],
    [Number.NaN, 0],
  ])('clamps a reported percentage of %s to %s', (input, expected) => {
    expect(normalizeProgress({ downloadedBytes: 0, percent: input }).percent).toBe(expected);
  });

  it('never reports more than 100 percent even when downloaded exceeds total', () => {
    // Happens with an under-reported total on a fragmented download.
    expect(normalizeProgress({ downloadedBytes: 300, totalBytes: 200 }).percent).toBe(100);
  });

  it('produces values a Postgres integer column will accept', () => {
    const normalized = normalizeProgress({
      downloadedBytes: 222452.7,
      totalBytes: 1492973.3333333335,
      percent: 14.9,
    });

    for (const value of [normalized.downloadedBytes, normalized.percent]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
    expect(Number.isSafeInteger(normalized.totalBytes ?? 0)).toBe(true);
  });
});
