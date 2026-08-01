import { ManualClock } from '@tgtools/shared';
import type { DownloadProgress } from '@tgtools/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProgressThrottler } from './progress-throttler.js';

function progress(percent: number | undefined, downloadedBytes = 1_000): DownloadProgress {
  return {
    downloadedBytes,
    totalBytes: percent === undefined ? undefined : 100_000,
    percent,
    speedBytesPerSecond: undefined,
    etaSeconds: undefined,
  };
}

describe('ProgressThrottler', () => {
  let clock: ManualClock;
  let throttler: ProgressThrottler;

  beforeEach(() => {
    clock = new ManualClock();
    throttler = new ProgressThrottler({ clock, minIntervalMs: 3_000, minPercentDelta: 5 });
  });

  it('always emits the first sample so the user sees something immediately', () => {
    expect(throttler.shouldEmit(progress(0))).toBe(true);
  });

  it('suppresses a sample that arrives too soon, however much moved', () => {
    throttler.shouldEmit(progress(0));
    clock.advance(500);
    // yt-dlp emits several samples a second; editing on each gets the chat
    // rate-limited within seconds.
    expect(throttler.shouldEmit(progress(50))).toBe(false);
  });

  it('suppresses a sample that moved too little, however long it has been', () => {
    throttler.shouldEmit(progress(10));
    clock.advance(60_000);
    expect(throttler.shouldEmit(progress(12))).toBe(false);
  });

  it('emits when both the time floor and the movement floor are cleared', () => {
    throttler.shouldEmit(progress(10));
    clock.advance(3_000);
    expect(throttler.shouldEmit(progress(20))).toBe(true);
  });

  it('always emits the jump to 100 so the bar never stops at 97 percent', () => {
    throttler.shouldEmit(progress(0));
    clock.advance(10);
    expect(throttler.shouldEmit(progress(100))).toBe(true);
  });

  it('emits 100 only once', () => {
    throttler.shouldEmit(progress(0));
    clock.advance(10);
    expect(throttler.shouldEmit(progress(100))).toBe(true);
    clock.advance(10);
    expect(throttler.shouldEmit(progress(100))).toBe(false);
  });

  it('falls back to the time floor alone when no percentage is reported', () => {
    // Instagram and TikTok routinely report no total, so there is no percentage
    // to compare and the clock is the only signal available.
    expect(throttler.shouldEmit(progress(undefined))).toBe(true);
    clock.advance(1_000);
    expect(throttler.shouldEmit(progress(undefined))).toBe(false);
    clock.advance(2_500);
    expect(throttler.shouldEmit(progress(undefined))).toBe(true);
  });

  it('emits immediately again after a reset, so a new stage renders at once', () => {
    throttler.shouldEmit(progress(30));
    throttler.reset();
    expect(throttler.shouldEmit(progress(31))).toBe(true);
  });

  it('bounds how many edits a full download can produce', () => {
    let emitted = 0;
    // 200 samples over 20 seconds — roughly what a fast download looks like.
    for (let i = 0; i <= 200; i += 1) {
      clock.advance(100);
      if (throttler.shouldEmit(progress(i / 2))) emitted += 1;
    }
    expect(emitted).toBeLessThanOrEqual(10);
  });
});
