import {
  DownloadJobStatus,
  InspectMediaUseCase,
  ProcessDownloadUseCase,
  RequestDownloadUseCase,
} from '@tgtools/feature-downloader';
import type { DownloadJobRepository, UpdateJobProgressInput } from '@tgtools/feature-downloader';
import type { Clock } from '@tgtools/shared';
import {
  ManualClock,
  MediaPlatform,
  SequentialIdGenerator,
  createNoopLogger,
  hashUrl,
} from '@tgtools/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AllowAllAccessPolicy,
  FakeQueue,
  FakeSender,
  RecordingReporter,
  ScriptedDownloader,
} from '../support/fakes.js';
import {
  InMemoryDownloadJobRepository,
  InMemoryInspectionCache,
  RecordingEventRepository,
} from '../support/in-memory-repositories.js';
import { instagramReelInfo } from '../support/media-fixtures.js';

const PIN_URL = 'https://www.pinterest.com/pin/1234567890/';
const USER_ID = 'user-1';

/**
 * The exact sample that took a worker down: yt-dlp divides a fragment count
 * into an estimate and does not round the result.
 */
const FRACTIONAL_SAMPLE = {
  downloadedBytes: 222452,
  totalBytes: 1492973.3333333335,
  percent: 14.9,
};

interface Harness {
  readonly jobs: InMemoryDownloadJobRepository;
  readonly downloader: ScriptedDownloader;
  readonly queue: FakeQueue;
  readonly sender: FakeSender;
  readonly writes: UpdateJobProgressInput[];
  readonly inspect: InspectMediaUseCase;
  readonly request: RequestDownloadUseCase;
  readonly process: ProcessDownloadUseCase;
}

function createHarness(options: { failProgressWrites?: boolean } = {}): Harness {
  const clock: ManualClock = new ManualClock(new Date('2026-06-01T12:00:00.000Z'));
  const logger = createNoopLogger();
  const ids = new SequentialIdGenerator();
  const jobs = new InMemoryDownloadJobRepository(clock as Clock);
  const events = new RecordingEventRepository();
  const cache = new InMemoryInspectionCache();
  const queue = new FakeQueue();
  const sender = new FakeSender();
  const downloader = new ScriptedDownloader();
  const accessPolicy = new AllowAllAccessPolicy();
  const writes: UpdateJobProgressInput[] = [];

  // Stands in for the Drizzle repository, recording exactly what would reach
  // Postgres. An explicit delegate rather than a prototype override: the
  // in-memory repository uses `#`-private fields, which are per-instance and
  // invisible through `Object.create`.
  const recordingJobs: DownloadJobRepository = {
    create: (input) => jobs.create(input),
    findById: (id) => jobs.findById(id),
    findByShortId: (shortId) => jobs.findByShortId(shortId),
    countActiveByUser: (userId) => jobs.countActiveByUser(userId),
    updateStatus: (input) => jobs.updateStatus(input),
    updateSelection: (input) => jobs.updateSelection(input),
    updateOutput: (input) => jobs.updateOutput(input),
    attachStatusMessage: (jobId, messageId) => jobs.attachStatusMessage(jobId, messageId),
    attachMediaTitle: (jobId, title) => jobs.attachMediaTitle(jobId, title),
    expireStaleSelections: (now, limit) => jobs.expireStaleSelections(now, limit),
    updateProgress: (input: UpdateJobProgressInput): Promise<void> => {
      writes.push(input);
      if (options.failProgressWrites === true) {
        // What postgres.js throws for a fractional value in a bigint column.
        return Promise.reject(new Error('Failed query: update "download_jobs"'));
      }
      return jobs.updateProgress(input);
    },
  };

  return {
    jobs,
    downloader,
    queue,
    sender,
    writes,
    inspect: new InspectMediaUseCase({
      downloader,
      jobs: recordingJobs,
      events,
      cache,
      accessPolicy,
      clock,
      ids,
      logger,
      cacheTtlSeconds: 600,
      selectionTtlSeconds: 1_800,
      resolveUrl: (rawUrl) =>
        Promise.resolve({
          platform: MediaPlatform.Pinterest,
          requestUrl: rawUrl,
          storable: {
            sourceUrl: rawUrl,
            normalizedUrl: rawUrl,
            normalizedUrlHash: hashUrl(rawUrl),
          },
        }),
    }),
    request: new RequestDownloadUseCase({
      jobs: recordingJobs,
      events,
      queue,
      accessPolicy,
      clock,
      logger,
    }),
    process: new ProcessDownloadUseCase({
      downloader,
      sender,
      jobs: recordingJobs,
      events,
      clock,
      logger,
      jobTimeoutMs: 1_800_000,
      maxUploadBytes: 50 * 1024 * 1024,
      progress: { intervalMs: 3_000, minPercentDelta: 5 },
      buildCaption: () => 'caption',
    }),
  };
}

async function runToCompletion(harness: Harness): Promise<string> {
  const info = instagramReelInfo({ platform: MediaPlatform.Pinterest, sourceUrl: PIN_URL });
  harness.downloader.inspectResult = info;

  const inspected = await harness.inspect.execute({
    userId: USER_ID,
    telegramChatId: 900_100,
    rawUrl: PIN_URL,
  });
  await harness.request.execute({
    shortId: inspected.shortId,
    optionId: 'v1080',
    requestId: 'req-1',
    actingUserId: USER_ID,
    telegramUserId: 4_242,
    statusMessageId: 77,
    availableOptions: info.availableOptions,
  });

  harness.downloader.downloadResult = { fileSize: 1_492_973 };
  await harness.process.execute({
    payload: harness.queue.next(),
    reporter: new RecordingReporter(),
    signal: new AbortController().signal,
  });

  return inspected.jobId;
}

describe('progress persistence never endangers the download', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onRejection);
  });

  it('never lets a fractional byte count reach the repository', async () => {
    const harness = createHarness();
    harness.downloader.progressSamples = [FRACTIONAL_SAMPLE];

    await runToCompletion(harness);

    expect(harness.writes.length).toBeGreaterThan(0);
    for (const write of harness.writes) {
      expect(Number.isInteger(write.downloadedBytes), 'downloadedBytes').toBe(true);
      expect(Number.isInteger(write.totalBytes ?? 0), 'totalBytes').toBe(true);
      expect(write.progressPercent).toBeGreaterThanOrEqual(0);
      expect(write.progressPercent).toBeLessThanOrEqual(100);
    }
  });

  it('completes the job even when every progress write fails', async () => {
    const harness = createHarness({ failProgressWrites: true });
    harness.downloader.progressSamples = [
      FRACTIONAL_SAMPLE,
      { downloadedBytes: 800_000, totalBytes: 1_492_973 },
      { downloadedBytes: 1_492_973, totalBytes: 1_492_973 },
    ];

    const jobId = await runToCompletion(harness);

    // The whole point: a rejected UPDATE is a cosmetic loss, not a lost file.
    expect(harness.jobs.peek(jobId)?.status).toBe(DownloadJobStatus.Completed);
    expect(harness.sender.sent).toHaveLength(1);
    expect(harness.downloader.cleanedUp).toBe(1);
  });

  it('produces no unhandled rejection when progress writes fail', async () => {
    const harness = createHarness({ failProgressWrites: true });
    harness.downloader.progressSamples = Array.from({ length: 30 }, (_, index) => ({
      downloadedBytes: (index + 1) * 1_000,
      totalBytes: 1492973.3333333335,
    }));

    await runToCompletion(harness);
    // Give any stray rejection a turn to surface.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // This is precisely what killed the worker: the rejection reached
    // `process.on('unhandledRejection')`, which the shutdown handler treats as
    // fatal, and the container exited 1 mid-download.
    expect(rejections).toEqual([]);
  });

  it('coalesces a burst of samples into far fewer writes', async () => {
    const harness = createHarness();
    harness.downloader.progressSamples = Array.from({ length: 40 }, (_, index) => ({
      downloadedBytes: (index + 1) * 10_000,
      totalBytes: 400_000,
    }));

    await runToCompletion(harness);

    expect(harness.writes.length).toBeLessThan(40);
  });

  it('persists the final progress state before the job completes', async () => {
    const harness = createHarness();
    harness.downloader.progressSamples = [
      { downloadedBytes: 100_000, totalBytes: 1_492_973 },
      { downloadedBytes: 1_492_973, totalBytes: 1_492_973 },
    ];

    await runToCompletion(harness);

    const last = harness.writes[harness.writes.length - 1];
    expect(last?.downloadedBytes).toBe(1_492_973);
    expect(last?.progressPercent).toBe(100);
  });

  it('cleans up the workspace after a failure, with progress writes also failing', async () => {
    const harness = createHarness({ failProgressWrites: true });
    harness.downloader.progressSamples = [FRACTIONAL_SAMPLE];
    const info = instagramReelInfo({ platform: MediaPlatform.Pinterest, sourceUrl: PIN_URL });
    harness.downloader.inspectResult = info;

    const inspected = await harness.inspect.execute({
      userId: USER_ID,
      telegramChatId: 900_100,
      rawUrl: PIN_URL,
    });
    await harness.request.execute({
      shortId: inspected.shortId,
      optionId: 'v1080',
      requestId: 'req-1',
      actingUserId: USER_ID,
      telegramUserId: 4_242,
      statusMessageId: 77,
      availableOptions: info.availableOptions,
    });

    harness.downloader.downloadResult = { fileSize: 1_000 };
    harness.sender.failWith = new Error('telegram is unwell');

    await harness.process
      .execute({
        payload: harness.queue.next(),
        reporter: new RecordingReporter(),
        signal: new AbortController().signal,
      })
      .catch(() => undefined);

    expect(harness.downloader.cleanedUp).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejections).toEqual([]);
  });
});
