import type { Logger } from '@tgtools/shared';
import {
  DOWNLOAD_TYPE_VALUES,
  MEDIA_KIND_VALUES,
  MEDIA_PLATFORM_VALUES,
  describeError,
} from '@tgtools/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { MediaInfo } from '../../domain/entities/media-info.js';
import type {
  MediaInspectionCache,
  MediaInspectionCacheKey,
} from '../../domain/ports/supporting-ports.js';

/**
 * Cached documents outlive the code that wrote them: a deploy can change the
 * shape of `MediaInfo` while yesterday's entries are still live. Validating on
 * read turns that from a crash into a cache miss.
 */
const cachedMediaInfoSchema = z.object({
  sourceUrl: z.string(),
  // Derived from the shared vocabulary; a hand-copied list here would turn
  // every lookup for a newly added platform into a permanent cache miss.
  platform: z.enum(MEDIA_PLATFORM_VALUES),
  title: z.string(),
  uploader: z.string().optional(),
  durationSeconds: z.number().optional(),
  thumbnailUrl: z.string().optional(),
  uploadDate: z.string().optional(),
  description: z.string().optional(),
  statistics: z.object({
    viewCount: z.number().optional(),
    likeCount: z.number().optional(),
    commentCount: z.number().optional(),
  }),
  mediaKind: z.enum(MEDIA_KIND_VALUES),
  requiredAuthentication: z.boolean(),
  formats: z.array(
    z.object({
      id: z.string(),
      ext: z.string(),
      height: z.number().optional(),
      width: z.number().optional(),
      videoCodec: z.string().optional(),
      audioCodec: z.string().optional(),
      filesizeBytes: z.number().optional(),
    }),
  ),
  availableOptions: z.array(
    z.object({
      id: z.string(),
      type: z.enum(DOWNLOAD_TYPE_VALUES),
      label: z.string(),
      height: z.number().optional(),
      audioBitrateKbps: z.number().optional(),
      estimatedBytes: z.number().optional(),
      formatId: z.string().optional(),
    }),
  ),
});

export class RedisMediaInspectionCache implements MediaInspectionCache {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async get(key: MediaInspectionCacheKey): Promise<MediaInfo | undefined> {
    try {
      const raw = await this.redis.get(buildKey(key));
      if (raw === null) return undefined;
      const parsed = cachedMediaInfoSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.debug('discarding a cache entry that no longer matches the schema');
        await this.invalidate(key);
        return undefined;
      }
      return parsed.data as MediaInfo;
    } catch (error: unknown) {
      // A cache is an optimisation. If Redis is unwell, the correct behaviour is
      // to go and ask the extractor, not to fail the user's request.
      this.logger.warn('media inspection cache read failed', { error: describeError(error) });
      return undefined;
    }
  }

  async set(key: MediaInspectionCacheKey, value: MediaInfo, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.set(buildKey(key), JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error: unknown) {
      this.logger.warn('media inspection cache write failed', { error: describeError(error) });
    }
  }

  async invalidate(key: MediaInspectionCacheKey): Promise<void> {
    try {
      await this.redis.del(buildKey(key));
    } catch (error: unknown) {
      this.logger.warn('media inspection cache delete failed', { error: describeError(error) });
    }
  }
}

/**
 * The authentication flag is part of the key, not of the value.
 *
 * A result fetched with operator cookies can describe a post an anonymous
 * visitor may not see; sharing one cache slot between the two would hand that
 * result to whoever asked next.
 */
export function buildKey(key: MediaInspectionCacheKey): string {
  return `media:inspect:${key.requiredAuth ? 'auth' : 'anon'}:${key.normalizedUrlHash}`;
}
