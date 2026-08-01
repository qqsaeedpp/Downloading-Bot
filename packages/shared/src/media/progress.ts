import type { DownloadProgress } from './vocabulary.js';

/**
 * A progress sample that is safe to store.
 *
 * Every field is a non-negative safe integer, and `totalBytes` is `undefined`
 * rather than a guess when the source did not give a usable one.
 */
export interface NormalizedProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | undefined;
  /** 0..100, integral. */
  readonly percent: number;
}

/**
 * Bring an extractor's progress sample into a shape the database will accept.
 *
 * This exists because yt-dlp reports fractions. A Pinterest download produced
 * `total_bytes = 1492973.3333333335` — it divides a fragment count into an
 * estimate and does not round — and Postgres rejected the value for a `bigint`
 * column. The rejected UPDATE became an unhandled rejection, which the worker's
 * shutdown handler treats as fatal, so one cosmetic progress row killed a
 * download that had otherwise succeeded.
 *
 * Normalising at the boundary, rather than widening the column, is the right
 * fix: a byte count is by definition a whole number, and storing 1492973.33 of
 * anything would be meaningless even if Postgres allowed it.
 */
export function normalizeProgress(sample: DownloadProgress): NormalizedProgress {
  // Floor, not round: reporting more bytes than have actually arrived would let
  // the bar reach 100% before the file does.
  const downloadedBytes = toByteCount(sample.downloadedBytes) ?? 0;
  const totalBytes = toByteCount(sample.totalBytes);

  return {
    downloadedBytes,
    totalBytes,
    percent: derivePercent(downloadedBytes, totalBytes, sample.percent),
  };
}

/**
 * `undefined` for anything that is not a usable count — including zero, which
 * as a *total* means "unknown" rather than "an empty file".
 */
function toByteCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? floored : undefined;
}

/**
 * Prefer the ratio we can compute over the one yt-dlp reports.
 *
 * Its own `percentage` is derived from a different estimate than its byte
 * counts and the two disagree often enough to make a bar jump backwards. The
 * reported value is only used when there is no total to divide by.
 */
function derivePercent(
  downloadedBytes: number,
  totalBytes: number | undefined,
  reported: number | undefined,
): number {
  if (totalBytes !== undefined && totalBytes > 0) {
    return clampPercent((downloadedBytes / totalBytes) * 100);
  }
  return reported === undefined ? 0 : clampPercent(reported);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
