import { describe, expect, it } from 'vitest';
import type { TargetSearchPolicy } from './target-size-search.js';
import {
  DEFAULT_TARGET_SEARCH_POLICY,
  estimateScale,
  searchForTargetSize,
} from './target-size-search.js';

const KB = 1024;

/**
 * A stand-in encoder whose size falls with quality and with area.
 *
 * Monotonic, which is the property the search relies on. Real encoders are
 * only approximately monotonic — a JPEG can occasionally grow by a byte or two
 * as quality drops — but the search never assumes exactness, only direction.
 */
function fakeEncoder(baseBytes: number) {
  const calls: { quality: number; scale: number }[] = [];
  const encode = (quality: number, scale: number): Promise<number> => {
    calls.push({ quality, scale });
    const qualityFactor = 0.2 + (quality / 100) * 0.8;
    return Promise.resolve(Math.round(baseBytes * qualityFactor * scale * scale));
  };
  return { encode, calls };
}

describe('estimateScale', () => {
  it('estimates from the square root, because size follows area', () => {
    // A quarter of the bytes needs about half the linear dimension.
    expect(estimateScale(400 * KB, 100 * KB)).toBeCloseTo(0.65, 2);
  });

  it('never shrinks by more than a third in one step', () => {
    // A single step to 0.1 would throw away far more detail than the target
    // requires, and the next stage cannot undo it.
    expect(estimateScale(1000 * KB, 1)).toBe(0.65);
  });

  it('never takes a step too small to be worth an encode', () => {
    expect(estimateScale(100 * KB, 99 * KB)).toBe(0.95);
    expect(estimateScale(100 * KB, 200 * KB)).toBe(0.95);
  });

  it('survives nonsense inputs rather than returning NaN', () => {
    // A zero-byte encode is a real possibility on a broken input, and NaN here
    // would silently poison every subsequent scale.
    for (const [current, target] of [
      [0, 100],
      [100, 0],
      [-5, 100],
    ] as const) {
      const scale = estimateScale(current, target);
      expect(Number.isFinite(scale), `${current}/${target}`).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });
});

describe('searchForTargetSize', () => {
  it('finds a fitting quality and reports the target met', async () => {
    const { encode } = fakeEncoder(500 * KB);
    const outcome = await searchForTargetSize(200 * KB, encode);

    expect(outcome.met).toBe(true);
    expect(outcome.sizeBytes).toBeLessThanOrEqual(200 * KB);
  });

  it('returns the HIGHEST quality that fits, not merely the first', async () => {
    // Spending the remaining headroom on quality is the whole point; stopping
    // at the first fit would hand back a needlessly degraded picture.
    const { encode } = fakeEncoder(500 * KB);
    const outcome = await searchForTargetSize(400 * KB, encode);

    expect(outcome.met).toBe(true);
    const better = await encode(outcome.quality + 1, outcome.scale);
    expect(better).toBeGreaterThan(400 * KB);
  });

  it('never exceeds its encode budget', async () => {
    // Each attempt is a full encode, so this is a wall-clock guarantee.
    const { encode, calls } = fakeEncoder(50_000 * KB);
    const policy: TargetSearchPolicy = { ...DEFAULT_TARGET_SEARCH_POLICY };
    await searchForTargetSize(1 * KB, encode, policy);

    const maxEncodes = policy.maxQualityAttempts * (policy.maxResizeStages + 1);
    expect(calls.length).toBeLessThanOrEqual(maxEncodes);
  });

  it('terminates on an impossible target instead of looping', async () => {
    const { encode } = fakeEncoder(10_000 * KB);
    const outcome = await searchForTargetSize(1, encode);

    expect(outcome.met).toBe(false);
    // Still returns the best it managed, which is more useful than a failure.
    expect(outcome.sizeBytes).toBeGreaterThan(0);
  });

  it('shrinks the image when quality alone cannot get there', async () => {
    const { encode, calls } = fakeEncoder(5_000 * KB);
    const outcome = await searchForTargetSize(300 * KB, encode);

    expect(calls.some((c) => c.scale < 1)).toBe(true);
    expect(outcome.scale).toBeLessThan(1);
  });

  it('does not resize when quality alone suffices', async () => {
    // A resize that was not needed costs detail for nothing.
    const { encode, calls } = fakeEncoder(300 * KB);
    const outcome = await searchForTargetSize(250 * KB, encode);

    expect(outcome.met).toBe(true);
    expect(outcome.scale).toBe(1);
    expect(calls.every((c) => c.scale === 1)).toBe(true);
  });

  it('returns the SMALLEST attempt when none fit, not the last', async () => {
    // The last attempt of a binary search is not necessarily the smallest, and
    // handing back a larger file than one already produced is indefensible.
    const { encode } = fakeEncoder(10_000 * KB);
    const outcome = await searchForTargetSize(1, encode);

    const smallest = Math.min(...outcome.attempts.map((a) => a.sizeBytes));
    expect(outcome.sizeBytes).toBe(smallest);
  });

  it('records every attempt for the log', async () => {
    const { encode } = fakeEncoder(500 * KB);
    const outcome = await searchForTargetSize(200 * KB, encode);

    expect(outcome.attempts.length).toBeGreaterThan(0);
    for (const attempt of outcome.attempts) {
      expect(attempt.quality).toBeGreaterThanOrEqual(DEFAULT_TARGET_SEARCH_POLICY.minQuality);
      expect(attempt.quality).toBeLessThanOrEqual(DEFAULT_TARGET_SEARCH_POLICY.maxQuality);
    }
  });

  it('stays within the configured quality bounds', async () => {
    // Below the floor the result stops being a photograph; above the ceiling
    // the file barely shrinks and the encode is wasted.
    const { encode, calls } = fakeEncoder(9_000 * KB);
    await searchForTargetSize(10 * KB, encode, { ...DEFAULT_TARGET_SEARCH_POLICY });

    for (const call of calls) {
      expect(call.quality).toBeGreaterThanOrEqual(DEFAULT_TARGET_SEARCH_POLICY.minQuality);
      expect(call.quality).toBeLessThanOrEqual(DEFAULT_TARGET_SEARCH_POLICY.maxQuality);
    }
  });

  it('honours a policy that forbids resizing', async () => {
    const { encode, calls } = fakeEncoder(5_000 * KB);
    const outcome = await searchForTargetSize(50 * KB, encode, {
      ...DEFAULT_TARGET_SEARCH_POLICY,
      maxResizeStages: 0,
    });

    expect(calls.every((c) => c.scale === 1)).toBe(true);
    expect(outcome.met).toBe(false);
  });
});
