import type {
  CreateDownloadJobInput,
  DownloadEventRepository,
  DownloadJob,
  DownloadJobRepository,
  MediaInfo,
  MediaInspectionCache,
  MediaInspectionCacheKey,
  UpdateJobStatusInput,
} from '@tgtools/feature-downloader';
import { ACTIVE_STATUSES, DownloadJobStatus, assertTransition } from '@tgtools/feature-downloader';
import type { Clock } from '@tgtools/shared';

/**
 * An in-memory `DownloadJobRepository` that keeps the two behaviours the use
 * cases actually depend on: the state machine refuses an illegal transition,
 * and every conditional write asserts the version it read.
 *
 * Without both, an end-to-end test would pass against a fake that cannot
 * reproduce the races the real one exists to prevent.
 */
export class InMemoryDownloadJobRepository implements DownloadJobRepository {
  readonly #byId = new Map<string, DownloadJob>();

  constructor(private readonly clock: Clock) {}

  create(input: CreateDownloadJobInput): Promise<DownloadJob> {
    const now = this.clock.now();
    const job: DownloadJob = {
      id: input.id,
      shortId: input.shortId,
      userId: input.userId,
      telegramChatId: input.telegramChatId,
      telegramStatusMessageId: input.telegramStatusMessageId,
      platform: input.platform,
      sourceUrl: input.sourceUrl,
      normalizedUrl: input.normalizedUrl,
      normalizedUrlHash: input.normalizedUrlHash,
      mediaTitle: undefined,
      mediaType: input.mediaType,
      requestedQuality: undefined,
      requestedFormatId: undefined,
      status: input.status,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: undefined,
      outputSize: undefined,
      outputMimeType: undefined,
      outputFileId: undefined,
      errorCode: undefined,
      errorMessageSafe: undefined,
      attemptCount: 0,
      createdAt: now,
      queuedAt: undefined,
      startedAt: undefined,
      completedAt: undefined,
      failedAt: undefined,
      expiresAt: input.expiresAt,
      updatedAt: now,
      version: 0,
    };
    this.#byId.set(job.id, job);
    return Promise.resolve(job);
  }

  findById(jobId: string): Promise<DownloadJob | undefined> {
    return Promise.resolve(this.#byId.get(jobId));
  }

  findByShortId(shortId: string): Promise<DownloadJob | undefined> {
    return Promise.resolve([...this.#byId.values()].find((job) => job.shortId === shortId));
  }

  countActiveByUser(userId: string): Promise<number> {
    const active = [...this.#byId.values()].filter(
      (job) => job.userId === userId && ACTIVE_STATUSES.includes(job.status),
    );
    return Promise.resolve(active.length);
  }

  updateStatus(input: UpdateJobStatusInput): Promise<boolean> {
    const job = this.#byId.get(input.jobId);
    if (job === undefined || job.version !== input.expectedVersion) return Promise.resolve(false);
    assertTransition(job.status, input.status);

    this.#byId.set(job.id, {
      ...job,
      status: input.status,
      errorCode: input.errorCode ?? job.errorCode,
      errorMessageSafe: input.errorMessageSafe ?? job.errorMessageSafe,
      queuedAt: input.queuedAt ?? job.queuedAt,
      startedAt: input.startedAt ?? job.startedAt,
      completedAt: input.completedAt ?? job.completedAt,
      failedAt: input.failedAt ?? job.failedAt,
      attemptCount: input.incrementAttempt === true ? job.attemptCount + 1 : job.attemptCount,
      updatedAt: this.clock.now(),
      version: job.version + 1,
    });
    return Promise.resolve(true);
  }

  updateSelection(input: {
    jobId: string;
    expectedVersion: number;
    mediaType: DownloadJob['mediaType'];
    requestedQuality: string | undefined;
    requestedFormatId: string | undefined;
    expiresAt: Date | undefined;
  }): Promise<boolean> {
    const job = this.#byId.get(input.jobId);
    if (job === undefined || job.version !== input.expectedVersion) return Promise.resolve(false);
    if (job.status !== DownloadJobStatus.AwaitingSelection) return Promise.resolve(false);

    this.#byId.set(job.id, {
      ...job,
      mediaType: input.mediaType,
      requestedQuality: input.requestedQuality,
      requestedFormatId: input.requestedFormatId,
      expiresAt: input.expiresAt,
      updatedAt: this.clock.now(),
      version: job.version + 1,
    });
    return Promise.resolve(true);
  }

  updateProgress(input: {
    jobId: string;
    progressPercent: number;
    downloadedBytes: number;
    totalBytes: number | undefined;
  }): Promise<void> {
    const job = this.#byId.get(input.jobId);
    if (job === undefined) return Promise.resolve();
    this.#byId.set(job.id, {
      ...job,
      progressPercent: input.progressPercent,
      downloadedBytes: input.downloadedBytes,
      totalBytes: input.totalBytes,
    });
    return Promise.resolve();
  }

  updateOutput(input: {
    jobId: string;
    outputSize: number;
    outputMimeType: string;
    outputFileId: string | undefined;
  }): Promise<void> {
    const job = this.#byId.get(input.jobId);
    if (job === undefined) return Promise.resolve();
    this.#byId.set(job.id, {
      ...job,
      outputSize: input.outputSize,
      outputMimeType: input.outputMimeType,
      outputFileId: input.outputFileId,
    });
    return Promise.resolve();
  }

  attachStatusMessage(jobId: string, messageId: number): Promise<void> {
    const job = this.#byId.get(jobId);
    if (job !== undefined) {
      this.#byId.set(jobId, { ...job, telegramStatusMessageId: messageId });
    }
    return Promise.resolve();
  }

  attachMediaTitle(jobId: string, title: string): Promise<void> {
    const job = this.#byId.get(jobId);
    if (job !== undefined) this.#byId.set(jobId, { ...job, mediaTitle: title });
    return Promise.resolve();
  }

  expireStaleSelections(now: Date, limit: number): Promise<number> {
    let expired = 0;
    for (const job of this.#byId.values()) {
      if (expired >= limit) break;
      if (job.status !== DownloadJobStatus.AwaitingSelection) continue;
      if (job.expiresAt === undefined || job.expiresAt.getTime() > now.getTime()) continue;
      this.#byId.set(job.id, {
        ...job,
        status: DownloadJobStatus.Expired,
        updatedAt: now,
        version: job.version + 1,
      });
      expired += 1;
    }
    return Promise.resolve(expired);
  }

  /** Test helper: the current row, bypassing the port. */
  peek(jobId: string): DownloadJob | undefined {
    return this.#byId.get(jobId);
  }
}

export class RecordingEventRepository implements DownloadEventRepository {
  readonly events: { jobId: string; eventType: string; payload: Record<string, unknown> }[] = [];

  record(input: {
    jobId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    this.events.push({ ...input, payload: { ...input.payload } });
    return Promise.resolve();
  }

  types(): string[] {
    return this.events.map((event) => event.eventType);
  }
}

export class InMemoryInspectionCache implements MediaInspectionCache {
  readonly #entries = new Map<string, MediaInfo>();

  get(key: MediaInspectionCacheKey): Promise<MediaInfo | undefined> {
    return Promise.resolve(this.#entries.get(serialise(key)));
  }

  set(key: MediaInspectionCacheKey, value: MediaInfo): Promise<void> {
    this.#entries.set(serialise(key), value);
    return Promise.resolve();
  }

  invalidate(key: MediaInspectionCacheKey): Promise<void> {
    this.#entries.delete(serialise(key));
    return Promise.resolve();
  }

  get size(): number {
    return this.#entries.size;
  }
}

function serialise(key: MediaInspectionCacheKey): string {
  return `${key.requiredAuth ? 'auth' : 'anon'}:${key.normalizedUrlHash}`;
}
