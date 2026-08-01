import type { Clock, IdGenerator, Logger, MediaPlatform } from '@tgtools/shared';
import { describeError, hashUrl, redactUrl } from '@tgtools/shared';
import { DownloadJobStatus } from '../../domain/entities/job-status.js';
import type { MediaInfo } from '../../domain/entities/media-info.js';
import { DownloadError, toDownloadError } from '../../domain/errors/download-error.js';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import type { DownloadJobRepository } from '../../domain/ports/download-job.repository.js';
import type { MediaDownloaderPort } from '../../domain/ports/media-downloader.port.js';
import type {
  DownloadAccessPolicy,
  DownloadEventRepository,
  MediaInspectionCache,
} from '../../domain/ports/supporting-ports.js';
import type { StorableUrl } from '../../domain/value-objects/media-url.js';

export interface InspectMediaCommand {
  readonly userId: string;
  readonly telegramChatId: number;
  readonly rawUrl: string;
  readonly signal?: AbortSignal | undefined;
}

export interface InspectMediaResult {
  readonly jobId: string;
  readonly shortId: string;
  readonly info: MediaInfo;
  readonly fromCache: boolean;
}

/**
 * Resolves a link into "here is what it is, and here is what you can have".
 *
 * Deliberately creates the job row *before* asking the extractor anything: the
 * row is what the concurrency limit counts, what the callback data points at,
 * and what a crash mid-inspection leaves behind for the sweeper to expire.
 */
export interface InspectMediaDependencies {
  readonly downloader: MediaDownloaderPort;
  readonly jobs: DownloadJobRepository;
  readonly events: DownloadEventRepository;
  readonly cache: MediaInspectionCache;
  readonly accessPolicy: DownloadAccessPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly cacheTtlSeconds: number;
  readonly selectionTtlSeconds: number;
  /** Validates and normalises the URL. Provided by infrastructure. */
  readonly resolveUrl: (
    rawUrl: string,
    signal: AbortSignal | undefined,
  ) => Promise<{ platform: MediaPlatform; storable: StorableUrl; requestUrl: string }>;
}

export class InspectMediaUseCase {
  constructor(private readonly deps: InspectMediaDependencies) {}

  async execute(command: InspectMediaCommand): Promise<InspectMediaResult> {
    const { deps } = this;

    if (!(await deps.accessPolicy.canInspect(command.userId))) {
      throw new DownloadError(
        DownloadFailureCode.RateLimited,
        'Inspection rate limit reached for this user',
      );
    }

    const resolved = await deps.resolveUrl(command.rawUrl, command.signal);
    const now = deps.clock.now();

    const job = await deps.jobs.create({
      id: deps.ids.uuid(),
      shortId: deps.ids.short(),
      userId: command.userId,
      telegramChatId: command.telegramChatId,
      telegramStatusMessageId: undefined,
      platform: resolved.platform,
      sourceUrl: resolved.storable.sourceUrl,
      normalizedUrl: resolved.storable.normalizedUrl,
      normalizedUrlHash: resolved.storable.normalizedUrlHash,
      // A placeholder until the user chooses; the row cannot be created without
      // one, and video is what the overwhelming majority of links turn out to be.
      mediaType: 'video',
      status: DownloadJobStatus.Pending,
      expiresAt: new Date(now.getTime() + deps.selectionTtlSeconds * 1000),
    });

    const logger = deps.logger.child({ jobId: job.id, platform: resolved.platform });

    await deps.jobs.updateStatus({
      jobId: job.id,
      expectedVersion: job.version,
      status: DownloadJobStatus.Inspecting,
    });

    try {
      const cacheKey = {
        normalizedUrlHash: resolved.storable.normalizedUrlHash,
        requiredAuth: false,
      };
      const cached = await deps.cache.get(cacheKey);
      if (cached !== undefined) {
        logger.debug('media info served from cache');
        await deps.jobs.attachMediaTitle(job.id, cached.title);
        await this.#markAwaitingSelection(job.id, job.version + 1);
        return { jobId: job.id, shortId: job.shortId, info: cached, fromCache: true };
      }

      const info = await deps.downloader.inspect({
        url: resolved.requestUrl,
        platform: resolved.platform,
        signal: command.signal,
      });

      if (info.availableOptions.length === 0) {
        throw new DownloadError(
          DownloadFailureCode.UnsupportedMedia,
          'The extractor returned nothing that can be delivered',
        );
      }

      // An authenticated result may show more than an anonymous visitor is
      // entitled to, so it is cached under its own key and never served to a
      // plain lookup.
      await deps.cache.set(
        {
          normalizedUrlHash: resolved.storable.normalizedUrlHash,
          requiredAuth: info.requiredAuthentication,
        },
        info,
        deps.cacheTtlSeconds,
      );

      await deps.jobs.attachMediaTitle(job.id, info.title);
      await this.#markAwaitingSelection(job.id, job.version + 1);
      await deps.events.record({
        jobId: job.id,
        eventType: 'inspected',
        payload: {
          platform: resolved.platform,
          mediaKind: info.mediaKind,
          options: info.availableOptions.length,
        },
      });

      logger.info('media inspected', {
        url: redactUrl(resolved.storable.normalizedUrl),
        mediaKind: info.mediaKind,
        options: info.availableOptions.length,
      });

      return { jobId: job.id, shortId: job.shortId, info, fromCache: false };
    } catch (error: unknown) {
      const downloadError = toDownloadError(error);
      logger.warn('inspection failed', {
        code: downloadError.code,
        error: describeError(error),
      });
      await deps.jobs.updateStatus({
        jobId: job.id,
        expectedVersion: job.version + 1,
        status: DownloadJobStatus.Failed,
        errorCode: downloadError.code,
        errorMessageSafe: downloadError.code,
        failedAt: deps.clock.now(),
      });
      throw downloadError;
    }
  }

  async #markAwaitingSelection(jobId: string, expectedVersion: number): Promise<void> {
    await this.deps.jobs.updateStatus({
      jobId,
      expectedVersion,
      status: DownloadJobStatus.AwaitingSelection,
    });
  }
}

/** Convenience for adapters that need the same hash the cache uses. */
export function hashNormalizedUrl(normalizedUrl: string): string {
  return hashUrl(normalizedUrl);
}
