import type { DownloadJobRow } from '@tgtools/database';
import type { DownloadJob } from '../../domain/entities/download-job.js';
import type { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';

/**
 * Database row to domain entity.
 *
 * `platform`, `mediaType` and `status` need no cast: Drizzle types a `pgEnum`
 * column as the union of its values, and those values are kept identical to the
 * domain vocabulary by `packages/database/src/schema/vocabulary.test.ts`, which
 * fails if the two ever drift.
 *
 * `errorCode` does need one — it is a plain `text` column, chosen so that a code
 * can be added without a migration. The alternative, validating every row at
 * runtime, would put a parse on the hot path of every callback.
 */
export function toDownloadJob(row: DownloadJobRow): DownloadJob {
  return {
    id: row.id,
    shortId: row.shortId,
    userId: row.userId,
    telegramChatId: row.telegramChatId,
    telegramStatusMessageId: row.telegramStatusMessageId ?? undefined,
    platform: row.platform,
    sourceUrl: row.sourceUrl,
    normalizedUrl: row.normalizedUrl,
    normalizedUrlHash: row.normalizedUrlHash,
    mediaTitle: row.mediaTitle ?? undefined,
    mediaType: row.mediaType,
    requestedQuality: row.requestedQuality ?? undefined,
    requestedFormatId: row.requestedFormatId ?? undefined,
    status: row.status,
    progressPercent: row.progressPercent,
    downloadedBytes: row.downloadedBytes,
    totalBytes: row.totalBytes ?? undefined,
    outputSize: row.outputSize ?? undefined,
    outputMimeType: row.outputMimeType ?? undefined,
    outputFileId: row.outputFileId ?? undefined,
    errorCode: (row.errorCode ?? undefined) as DownloadFailureCode | undefined,
    errorMessageSafe: row.errorMessageSafe ?? undefined,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    failedAt: row.failedAt ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}
