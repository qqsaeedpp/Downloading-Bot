import type { DownloadProgress, Logger } from '@tgtools/shared';
import { describeError, normalizeProgress } from '@tgtools/shared';
import type { UpdateJobProgressInput } from '../../domain/ports/download-job.repository.js';

export interface ProgressWriterOptions {
  readonly jobId: string;
  readonly requestId: string;
  readonly logger: Logger;
  readonly update: (input: UpdateJobProgressInput) => Promise<void>;
}

/**
 * Persists download progress without ever being able to harm the download.
 *
 * Four separate failures came together to kill a worker mid-job, and this class
 * exists to close all of them:
 *
 * 1. **Fractional bytes.** yt-dlp reported `total_bytes = 1492973.3333333335`
 *    and Postgres refused it for a `bigint` column. Every sample now goes
 *    through {@link normalizeProgress} first.
 * 2. **Unhandled rejection.** The failing UPDATE's promise was passed to `void`,
 *    so its rejection reached `process.on('unhandledRejection')` — which the
 *    shutdown handler correctly treats as fatal. A cosmetic write must never be
 *    able to do that, so every failure is caught here.
 * 3. **Write storms.** One UPDATE per progress sample meant dozens of
 *    overlapping writes against the same row. Only one is in flight at a time
 *    now, and the newest pending sample wins.
 * 4. **Leaks.** The writer stops accepting work once closed, so a finished,
 *    failed or cancelled job leaves nothing scheduled.
 *
 * Progress is advisory. Losing a sample costs a stale percentage for a few
 * seconds; losing the job costs the user their file.
 */
export class ProgressWriter {
  #pending: UpdateJobProgressInput | undefined;
  #inFlight: Promise<void> | undefined;
  #lastWritten: UpdateJobProgressInput | undefined;
  #closed = false;

  constructor(private readonly options: ProgressWriterOptions) {}

  /**
   * Record a sample. Returns immediately and never throws — the download path
   * calls this from inside yt-dlp's progress callback, where an exception would
   * propagate into the extractor.
   */
  submit(sample: DownloadProgress): void {
    if (this.#closed) return;

    const normalized = normalizeProgress(sample);
    const candidate: UpdateJobProgressInput = {
      jobId: this.options.jobId,
      progressPercent: normalized.percent,
      downloadedBytes: normalized.downloadedBytes,
      totalBytes: normalized.totalBytes,
    };

    if (!this.#isWorthWriting(candidate)) return;

    this.#pending = candidate;
    this.#drain();
  }

  /**
   * Tell the writer that the byte counter has legitimately restarted — a merge
   * step beginning against a different total, for instance. Without this the
   * monotonic guard would discard every sample of the new phase.
   */
  beginPhase(): void {
    this.#lastWritten = undefined;
  }

  /** Wait for the queue to empty. Used by tests and before completion. */
  async flush(): Promise<void> {
    while (this.#inFlight !== undefined || this.#pending !== undefined) {
      if (this.#inFlight !== undefined) await this.#inFlight;
      else this.#drain();
    }
  }

  /**
   * Write the newest sample and stop accepting more.
   *
   * Called on every exit path so that the last useful state reaches the
   * database before the job is marked completed, and so that nothing remains
   * scheduled afterwards.
   */
  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
  }

  /**
   * Skip a sample that would tell the user nothing new, or would tell them
   * something wrong.
   *
   * Backward movement is the interesting case: a fragmented download can reset
   * its byte counter mid-stream, and a bar that jumps from 90% back to 10%
   * reads as a failure to the person watching it. {@link beginPhase} is how a
   * legitimate reset is declared.
   *
   * The percent is consulted before the byte counter because the two can
   * disagree honestly. The sample that completes a download carries percent 100
   * with the counter already zeroed for the next phase; judged on bytes alone it
   * looked like a rewind and was dropped, so no job ever recorded 100.
   */
  #isWorthWriting(candidate: UpdateJobProgressInput): boolean {
    const previous = this.#lastWritten;
    if (previous === undefined) return true;

    const advances =
      candidate.progressPercent !== undefined &&
      previous.progressPercent !== undefined &&
      candidate.progressPercent > previous.progressPercent;
    if (!advances && candidate.downloadedBytes < previous.downloadedBytes) return false;
    return (
      candidate.downloadedBytes !== previous.downloadedBytes ||
      candidate.progressPercent !== previous.progressPercent ||
      candidate.totalBytes !== previous.totalBytes
    );
  }

  /** Start a write if none is running. Latest pending sample wins. */
  #drain(): void {
    if (this.#inFlight !== undefined) return;
    const next = this.#pending;
    if (next === undefined) return;
    this.#pending = undefined;

    this.#inFlight = this.options
      .update(next)
      .then(() => {
        this.#lastWritten = next;
      })
      .catch((error: unknown) => {
        // Logged, never rethrown. `requestId` is what ties this line back to the
        // user's original message; the normalised values are what a reader needs
        // to tell a driver problem from a bad sample. No URL, no secret.
        this.options.logger.warn('failed to persist download progress', {
          jobId: this.options.jobId,
          requestId: this.options.requestId,
          progressPercent: next.progressPercent,
          downloadedBytes: next.downloadedBytes,
          totalBytes: next.totalBytes,
          error: describeError(error),
        });
      })
      .finally(() => {
        this.#inFlight = undefined;
        // A sample that arrived while this write was running is now the newest.
        this.#drain();
      });
  }
}
