import {
  CancelDownloadUseCase,
  DownloadError,
  DownloadFailureCode,
  DownloadJobStatus,
  InspectMediaUseCase,
  ProcessDownloadUseCase,
  RequestDownloadUseCase,
  toQualityString,
} from '@tgtools/feature-downloader';
import type { DownloadJob, MediaInfo } from '@tgtools/feature-downloader';
import type { Clock } from '@tgtools/shared';
import {
  DownloadStage,
  DownloadType,
  ManualClock,
  MediaPlatform,
  SequentialIdGenerator,
  createNoopLogger,
  hashUrl,
} from '@tgtools/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AllowAllAccessPolicy,
  FakeCancellationBus,
  FakeQueue,
  FakeSender,
  RecordingReporter,
  ScriptedDownloader,
  downloadError,
} from '../support/fakes.js';
import {
  InMemoryDownloadJobRepository,
  InMemoryInspectionCache,
  RecordingEventRepository,
} from '../support/in-memory-repositories.js';
import { VIDEO_OPTIONS, instagramReelInfo, pinterestPinInfo } from '../support/media-fixtures.js';

const REEL_URL = 'https://www.instagram.com/reel/Cx1y2z3AbCd/';
const USER_ID = 'user-1';
const CHAT_ID = 900_100;
const TELEGRAM_USER_ID = 4_242;

interface Harness {
  readonly clock: ManualClock;
  readonly jobs: InMemoryDownloadJobRepository;
  readonly events: RecordingEventRepository;
  readonly cache: InMemoryInspectionCache;
  readonly queue: FakeQueue;
  readonly sender: FakeSender;
  readonly cancellations: FakeCancellationBus;
  readonly downloader: ScriptedDownloader;
  readonly accessPolicy: AllowAllAccessPolicy;
  readonly inspect: InspectMediaUseCase;
  readonly request: RequestDownloadUseCase;
  readonly cancel: CancelDownloadUseCase;
  readonly process: ProcessDownloadUseCase;
}

/**
 * The whole feature, wired with in-memory adapters.
 *
 * Real use cases, real state machine, real optimistic locking — only the
 * process boundaries are faked. That is the point: these tests exercise the
 * decisions, not the drivers.
 */
function createHarness(): Harness {
  const clock: ManualClock = new ManualClock(new Date('2026-06-01T12:00:00.000Z'));
  const logger = createNoopLogger();
  const ids = new SequentialIdGenerator();
  const jobs = new InMemoryDownloadJobRepository(clock as Clock);
  const events = new RecordingEventRepository();
  const cache = new InMemoryInspectionCache();
  const queue = new FakeQueue();
  const sender = new FakeSender();
  const cancellations = new FakeCancellationBus();
  const downloader = new ScriptedDownloader();
  const accessPolicy = new AllowAllAccessPolicy();

  const inspect = new InspectMediaUseCase({
    downloader,
    jobs,
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
        platform: MediaPlatform.Instagram,
        requestUrl: rawUrl,
        storable: {
          sourceUrl: rawUrl,
          normalizedUrl: rawUrl,
          normalizedUrlHash: hashUrl(rawUrl),
        },
      }),
  });

  return {
    clock,
    jobs,
    events,
    cache,
    queue,
    sender,
    cancellations,
    downloader,
    accessPolicy,
    inspect,
    request: new RequestDownloadUseCase({ jobs, events, queue, accessPolicy, clock, logger }),
    cancel: new CancelDownloadUseCase({ jobs, events, queue, cancellations, clock, logger }),
    process: new ProcessDownloadUseCase({
      downloader,
      sender,
      jobs,
      events,
      clock,
      logger,
      jobTimeoutMs: 1_800_000,
      maxUploadBytes: 50 * 1024 * 1024,
      progress: { intervalMs: 3_000, minPercentDelta: 5 },
      buildCaption: (job) => job.mediaTitle ?? 'media',
    }),
  };
}

async function inspectAndSelect(
  harness: Harness,
  info: MediaInfo = instagramReelInfo(),
  optionId = 'v1080',
): Promise<{ job: DownloadJob; shortId: string }> {
  harness.downloader.inspectResult = info;
  const inspected = await harness.inspect.execute({
    userId: USER_ID,
    telegramChatId: CHAT_ID,
    rawUrl: REEL_URL,
  });

  const requested = await harness.request.execute({
    shortId: inspected.shortId,
    optionId,
    requestId: 'req-1',
    actingUserId: USER_ID,
    telegramUserId: TELEGRAM_USER_ID,
    statusMessageId: 77,
    availableOptions: info.availableOptions,
  });

  return { job: requested.job, shortId: inspected.shortId };
}

describe('the happy path, end to end', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('carries a link from paste to delivered file', async () => {
    const { job } = await inspectAndSelect(harness);

    expect(job.status).toBe(DownloadJobStatus.Queued);
    expect(job.requestedQuality).toBe('1080p');
    expect(harness.queue.enqueued).toHaveLength(1);

    harness.downloader.downloadResult = { fileSize: 12 * 1024 * 1024 };
    const reporter = new RecordingReporter();
    const outcome = await harness.process.execute({
      payload: harness.queue.next(),
      reporter,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('completed');

    const finished = harness.jobs.peek(job.id);
    expect(finished?.status).toBe(DownloadJobStatus.Completed);
    expect(finished?.outputSize).toBe(12 * 1024 * 1024);
    expect(finished?.outputFileId).toBe('file-1');

    expect(harness.sender.sent).toHaveLength(1);
    expect(harness.sender.sent[0]?.chatId).toBe(CHAT_ID);
    // Cleanup is the invariant that matters most: a workspace left behind on a
    // shared volume is how a disk fills.
    expect(harness.downloader.cleanedUp).toBe(1);
    expect(reporter.completed).toBe(true);
    expect(reporter.stages).toContain(DownloadStage.Uploading);
  });

  it('records the media title so the delivered file has a caption', async () => {
    const { job } = await inspectAndSelect(harness);
    expect(harness.jobs.peek(job.id)?.mediaTitle).toBe('A reel worth keeping');
  });

  it('passes the selected quality through to the downloader', async () => {
    await inspectAndSelect(harness, instagramReelInfo(), 'v720');
    harness.downloader.downloadResult = { fileSize: 1_000 };
    await harness.process.execute({
      payload: harness.queue.next(),
      reporter: new RecordingReporter(),
      signal: new AbortController().signal,
    });
    expect(harness.downloader.downloadRequests[0]?.quality).toBe('720p');
  });

  it('serves a second request for the same link from the cache', async () => {
    harness.downloader.inspectResult = instagramReelInfo();
    await harness.inspect.execute({ userId: USER_ID, telegramChatId: CHAT_ID, rawUrl: REEL_URL });
    const second = await harness.inspect.execute({
      userId: USER_ID,
      telegramChatId: CHAT_ID,
      rawUrl: REEL_URL,
    });

    expect(second.fromCache).toBe(true);
    // One extractor call for two requests.
    expect(harness.downloader.inspectRequests).toHaveLength(1);
  });

  it('offers an image download for an image-only pin', async () => {
    harness.downloader.inspectResult = pinterestPinInfo();
    const result = await harness.inspect.execute({
      userId: USER_ID,
      telegramChatId: CHAT_ID,
      rawUrl: 'https://www.pinterest.com/pin/1234567890/',
    });
    expect(result.info.availableOptions).toHaveLength(1);
    expect(result.info.availableOptions[0]?.type).toBe(DownloadType.Image);
  });
});

describe('idempotency and races', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('ignores a redelivery of a completed job instead of downloading twice', async () => {
    await inspectAndSelect(harness);
    harness.downloader.downloadResult = { fileSize: 1_000 };
    const payload = harness.queue.next();

    await harness.process.execute({
      payload,
      reporter: new RecordingReporter(),
      signal: new AbortController().signal,
    });
    const second = await harness.process.execute({
      payload,
      reporter: new RecordingReporter(),
      signal: new AbortController().signal,
    });

    // BullMQ can deliver the same job twice; the user must not receive the file
    // twice, and the extractor must not be asked twice.
    expect(second).toBe('skipped');
    expect(harness.sender.sent).toHaveLength(1);
    expect(harness.downloader.downloadRequests).toHaveLength(1);
  });

  it('lets only the first of two rapid taps queue a download', async () => {
    harness.downloader.inspectResult = instagramReelInfo();
    const inspected = await harness.inspect.execute({
      userId: USER_ID,
      telegramChatId: CHAT_ID,
      rawUrl: REEL_URL,
    });

    const tap = () =>
      harness.request.execute({
        shortId: inspected.shortId,
        optionId: 'v1080',
        requestId: 'req',
        actingUserId: USER_ID,
        telegramUserId: TELEGRAM_USER_ID,
        statusMessageId: 77,
        availableOptions: VIDEO_OPTIONS,
      });

    await tap();
    await expect(tap()).rejects.toBeInstanceOf(DownloadError);
    expect(harness.queue.enqueued).toHaveLength(1);
  });

  it('refuses a tap from someone else in the chat', async () => {
    harness.downloader.inspectResult = instagramReelInfo();
    const inspected = await harness.inspect.execute({
      userId: USER_ID,
      telegramChatId: CHAT_ID,
      rawUrl: REEL_URL,
    });

    // In a group the card is visible to everyone; without an ownership check
    // anyone could spend another person's quota.
    await expect(
      harness.request.execute({
        shortId: inspected.shortId,
        optionId: 'v1080',
        requestId: 'req',
        actingUserId: 'someone-else',
        telegramUserId: 999,
        statusMessageId: 77,
        availableOptions: VIDEO_OPTIONS,
      }),
    ).rejects.toMatchObject({ code: DownloadFailureCode.SelectionExpired });
    expect(harness.queue.enqueued).toHaveLength(0);
  });

  it('refuses a tap on a card that has expired', async () => {
    harness.downloader.inspectResult = instagramReelInfo();
    const inspected = await harness.inspect.execute({
      userId: USER_ID,
      telegramChatId: CHAT_ID,
      rawUrl: REEL_URL,
    });

    harness.clock.advance(2 * 60 * 60 * 1000);

    await expect(
      harness.request.execute({
        shortId: inspected.shortId,
        optionId: 'v1080',
        requestId: 'req',
        actingUserId: USER_ID,
        telegramUserId: TELEGRAM_USER_ID,
        statusMessageId: 77,
        availableOptions: VIDEO_OPTIONS,
      }),
    ).rejects.toMatchObject({ code: DownloadFailureCode.SelectionExpired });
  });

  it('discards a queue message whose job row is gone', async () => {
    await inspectAndSelect(harness);
    const payload = { ...harness.queue.next(), jobId: 'never-existed' };
    const outcome = await harness.process.execute({
      payload,
      reporter: new RecordingReporter(),
      signal: new AbortController().signal,
    });
    expect(outcome).toBe('skipped');
  });
});

describe('limits and refusals', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('refuses a download when the user is already at their limit', async () => {
    harness.downloader.inspectResult = instagramReelInfo();
    const inspected = await harness.inspect.execute({
      userId: USER_ID,
      telegramChatId: CHAT_ID,
      rawUrl: REEL_URL,
    });
    harness.accessPolicy.downloadAllowed = false;

    await expect(
      harness.request.execute({
        shortId: inspected.shortId,
        optionId: 'v1080',
        requestId: 'req',
        actingUserId: USER_ID,
        telegramUserId: TELEGRAM_USER_ID,
        statusMessageId: 77,
        availableOptions: VIDEO_OPTIONS,
      }),
    ).rejects.toMatchObject({ code: DownloadFailureCode.TooManyActiveJobs });
  });

  it('refuses an inspection when the rate limit is exhausted', async () => {
    harness.accessPolicy.inspectAllowed = false;
    await expect(
      harness.inspect.execute({ userId: USER_ID, telegramChatId: CHAT_ID, rawUrl: REEL_URL }),
    ).rejects.toMatchObject({ code: DownloadFailureCode.RateLimited });
  });

  it('refuses a file that downloaded fine but is too large to send', async () => {
    await inspectAndSelect(harness);
    // The download ceiling and the upload ceiling are different numbers, and a
    // file can clear the first and fail the second.
    harness.downloader.downloadResult = { fileSize: 300 * 1024 * 1024 };

    const reporter = new RecordingReporter();
    const outcome = await harness.process.execute({
      payload: harness.queue.next(),
      reporter,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('skipped');
    expect(reporter.failures).toContain(DownloadFailureCode.MediaTooLarge);
    expect(harness.sender.sent).toHaveLength(0);
    expect(harness.downloader.cleanedUp).toBeGreaterThanOrEqual(1);
  });

  it('marks a private post failed and tells the user why', async () => {
    harness.downloader.inspectResult = downloadError(DownloadFailureCode.PrivateMedia);
    await expect(
      harness.inspect.execute({ userId: USER_ID, telegramChatId: CHAT_ID, rawUrl: REEL_URL }),
    ).rejects.toMatchObject({ code: DownloadFailureCode.PrivateMedia });
  });
});

describe('failure handling', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('marks a permanent failure failed and does not ask for a retry', async () => {
    const { job } = await inspectAndSelect(harness);
    harness.downloader.downloadResult = downloadError(DownloadFailureCode.MediaNotFound);

    const reporter = new RecordingReporter();
    const outcome = await harness.process.execute({
      payload: harness.queue.next(),
      reporter,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('skipped');
    expect(harness.jobs.peek(job.id)?.status).toBe(DownloadJobStatus.Failed);
    expect(reporter.failures).toEqual([DownloadFailureCode.MediaNotFound]);
    expect(harness.events.types()).toContain('failed');
  });

  it('rethrows a transient failure so the queue can retry it', async () => {
    const { job } = await inspectAndSelect(harness);
    harness.downloader.downloadResult = downloadError(DownloadFailureCode.DownloadTimeout);

    await expect(
      harness.process.execute({
        payload: harness.queue.next(),
        reporter: new RecordingReporter(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DownloadError);

    // Writing `failed` here would make a retryable job look final to the user
    // and to the maintenance sweep.
    expect(harness.jobs.peek(job.id)?.status).toBe(DownloadJobStatus.Downloading);
  });

  it('cleans up the workspace even when the upload fails', async () => {
    await inspectAndSelect(harness);
    harness.downloader.downloadResult = { fileSize: 1_000 };
    harness.sender.failWith = new DownloadError(DownloadFailureCode.UploadFailed, 'nope');

    await harness.process
      .execute({
        payload: harness.queue.next(),
        reporter: new RecordingReporter(),
        signal: new AbortController().signal,
      })
      .catch(() => undefined);

    expect(harness.downloader.cleanedUp).toBe(1);
  });
});

describe('cancellation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('stops a queued job and broadcasts the intent to the workers', async () => {
    const { job, shortId } = await inspectAndSelect(harness);

    const outcome = await harness.cancel.execute({ shortId, actingUserId: USER_ID });

    expect(outcome).toBe('cancelled');
    expect(harness.jobs.peek(job.id)?.status).toBe(DownloadJobStatus.Cancelled);
    expect(harness.queue.removed).toEqual([job.id]);
    // Marking the row alone would leave a running yt-dlp pulling bytes until
    // its own timeout fired, minutes later.
    expect(harness.cancellations.published).toEqual([job.id]);
  });

  it('stops a running download when its signal aborts', async () => {
    const { job } = await inspectAndSelect(harness);
    harness.downloader.waitForAbort = true;

    const controller = new AbortController();
    const running = harness.process.execute({
      payload: harness.queue.next(),
      reporter: new RecordingReporter(),
      signal: controller.signal,
    });

    // Give the processor a turn to reach the download.
    await Promise.resolve();
    controller.abort(new Error('user cancelled'));

    await expect(running).resolves.toBe('cancelled');
    expect(harness.jobs.peek(job.id)?.status).toBe(DownloadJobStatus.Cancelled);
  });

  it('reports an already-finished job as such rather than as an error', async () => {
    const { shortId } = await inspectAndSelect(harness);
    harness.downloader.downloadResult = { fileSize: 1_000 };
    await harness.process.execute({
      payload: harness.queue.next(),
      reporter: new RecordingReporter(),
      signal: new AbortController().signal,
    });

    // Losing the race against completion is a perfectly good outcome for the
    // user — the file arrived.
    await expect(harness.cancel.execute({ shortId, actingUserId: USER_ID })).resolves.toBe(
      'already-finished',
    );
  });
});

describe('quality strings', () => {
  it('renders the quality the worker will be given', () => {
    expect(toQualityString(VIDEO_OPTIONS[0]!)).toBe('1080p');
    expect(toQualityString(VIDEO_OPTIONS[2]!)).toBe('192k');
  });
});
