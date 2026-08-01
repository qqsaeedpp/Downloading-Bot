import { createNoopLogger } from '@tgtools/shared';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateJobProgressInput } from '../../domain/ports/download-job.repository.js';
import { ProgressWriter } from './progress-writer.js';

function createWriter(
  update: (input: UpdateJobProgressInput) => Promise<void>,
  jobId = 'job-1',
): ProgressWriter {
  return new ProgressWriter({
    jobId,
    requestId: 'req-1',
    logger: createNoopLogger(),
    update,
  });
}

/** Resolves once the microtask queue has drained a few times. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('ProgressWriter', () => {
  it('normalises a fractional total before it reaches the repository', async () => {
    const writes: UpdateJobProgressInput[] = [];
    const writer = createWriter((input) => {
      writes.push(input);
      return Promise.resolve();
    });

    // The exact values that crashed a worker on a Pinterest download.
    writer.submit({ downloadedBytes: 222452, totalBytes: 1492973.3333333335 });
    await writer.flush();

    expect(writes).toHaveLength(1);
    expect(Number.isInteger(writes[0]?.totalBytes ?? 0)).toBe(true);
    expect(writes[0]?.totalBytes).toBe(1492973);
  });

  it('coalesces a burst into a single write carrying the newest values', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const writes: UpdateJobProgressInput[] = [];

    const writer = createWriter(async (input) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      writes.push(input);
      inFlight -= 1;
    });

    // yt-dlp emits several samples a second; the old code issued one UPDATE per
    // sample and let them race.
    for (let i = 1; i <= 50; i += 1) {
      writer.submit({ downloadedBytes: i * 1_000, totalBytes: 50_000 });
    }
    await writer.flush();

    expect(maxConcurrent).toBe(1);
    expect(writes.length).toBeLessThan(50);
    // Latest-wins: the final state must be the last sample, not a stale one.
    expect(writes[writes.length - 1]?.downloadedBytes).toBe(50_000);
  });

  it('keeps exactly one write in flight at a time', async () => {
    let resolveFirst: (() => void) | undefined;
    let started = 0;

    const writer = createWriter(async () => {
      started += 1;
      if (started === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    writer.submit({ downloadedBytes: 1 });
    await settle();
    expect(started).toBe(1);

    writer.submit({ downloadedBytes: 2 });
    writer.submit({ downloadedBytes: 3 });
    await settle();
    // Still blocked on the first write, so nothing else has been issued.
    expect(started).toBe(1);

    resolveFirst?.();
    await writer.flush();
    expect(started).toBe(2);
  });

  it('swallows a persistence failure instead of producing an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    try {
      const writer = createWriter(() => Promise.reject(new Error('bigint out of range')));

      // The original code passed the raw promise to `void`, so a rejected
      // UPDATE became an unhandledRejection, which the shutdown handler treats
      // as fatal — that is how one bad progress row killed the worker.
      writer.submit({ downloadedBytes: 1, totalBytes: 2.5 });
      await expect(writer.flush()).resolves.toBeUndefined();
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('keeps accepting progress after a failed write', async () => {
    let call = 0;
    const succeeded: number[] = [];
    const writer = createWriter((input) => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('transient'));
      succeeded.push(input.downloadedBytes);
      return Promise.resolve();
    });

    writer.submit({ downloadedBytes: 1 });
    await writer.flush();
    writer.submit({ downloadedBytes: 2 });
    await writer.flush();

    // A transient failure must not poison the writer for the rest of the job.
    expect(succeeded).toEqual([2]);
  });

  it('drops a sample that carries nothing usable', async () => {
    const writes: UpdateJobProgressInput[] = [];
    const writer = createWriter((input) => {
      writes.push(input);
      return Promise.resolve();
    });

    writer.submit({ downloadedBytes: Number.NaN, totalBytes: Number.NaN });
    await writer.flush();

    // Normalised to zero rather than rejected outright — but never NaN.
    expect(writes[0]?.downloadedBytes).toBe(0);
    expect(writes[0]?.totalBytes).toBeUndefined();
  });

  it('does not let progress travel backwards', async () => {
    const writes: UpdateJobProgressInput[] = [];
    const writer = createWriter((input) => {
      writes.push(input);
      return Promise.resolve();
    });

    writer.submit({ downloadedBytes: 5_000, totalBytes: 10_000 });
    await writer.flush();
    // A fragmented download can restart its byte counter mid-stream; showing
    // the bar jump back to 10% reads as a failure to the person watching.
    writer.submit({ downloadedBytes: 1_000, totalBytes: 10_000 });
    await writer.flush();

    expect(writes).toHaveLength(1);
  });

  it('accepts a reset when the downloader legitimately changes phase', async () => {
    const writes: UpdateJobProgressInput[] = [];
    const writer = createWriter((input) => {
      writes.push(input);
      return Promise.resolve();
    });

    writer.submit({ downloadedBytes: 9_000, totalBytes: 10_000 });
    await writer.flush();
    // Merging a second stream restarts the counter against a new total.
    writer.beginPhase();
    writer.submit({ downloadedBytes: 100, totalBytes: 40_000 });
    await writer.flush();

    expect(writes).toHaveLength(2);
    expect(writes[1]?.downloadedBytes).toBe(100);
  });

  it('stops writing once closed, so a finished job leaks nothing', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const writer = createWriter(update);

    writer.submit({ downloadedBytes: 1 });
    await writer.flush();
    await writer.close();

    writer.submit({ downloadedBytes: 2 });
    await writer.flush();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('flushes the newest pending sample when closing', async () => {
    const writes: UpdateJobProgressInput[] = [];
    const writer = createWriter(async (input) => {
      await Promise.resolve();
      writes.push(input);
    });

    writer.submit({ downloadedBytes: 1_000, totalBytes: 10_000 });
    writer.submit({ downloadedBytes: 10_000, totalBytes: 10_000 });
    await writer.close();

    // The last useful state must reach the database before the job completes.
    expect(writes[writes.length - 1]?.downloadedBytes).toBe(10_000);
    expect(writes[writes.length - 1]?.progressPercent).toBe(100);
  });
});
