import type { Clock, DownloadProgress } from '@tgtools/shared';

export interface ProgressThrottlerOptions {
  readonly clock: Clock;
  /** Never edit more often than this, whatever changed. */
  readonly minIntervalMs: number;
  /** Never edit for less than this much movement, however long it has been. */
  readonly minPercentDelta: number;
}

/**
 * Decides when a progress update is worth a Telegram API call.
 *
 * yt-dlp emits a sample several times a second. Editing on each one gets the
 * chat rate-limited within seconds, and the user cannot read it anyway. The
 * reference implementation throttled on percentage alone, which still produced
 * a burst of twenty edits for a file that downloads in two seconds — hence the
 * time floor as well.
 *
 * Both conditions must hold, with two deliberate exceptions: the first sample
 * always renders (so the user sees something immediately), and a transition to
 * 100% always renders (so the bar never stops at 97%).
 */
export class ProgressThrottler {
  #lastEmittedAtMs: number | undefined;
  #lastPercent: number | undefined;

  constructor(private readonly options: ProgressThrottlerOptions) {}

  shouldEmit(progress: DownloadProgress): boolean {
    const now = this.options.clock.monotonicMs();

    if (this.#lastEmittedAtMs === undefined) {
      this.#record(now, progress.percent);
      return true;
    }

    const percent = progress.percent;
    if (percent !== undefined && percent >= 100 && this.#lastPercent !== 100) {
      this.#record(now, percent);
      return true;
    }

    if (now - this.#lastEmittedAtMs < this.options.minIntervalMs) return false;

    // No percentage at all — TikTok and Instagram routinely report no total —
    // so the time floor is the only signal available, and it is enough.
    if (percent === undefined || this.#lastPercent === undefined) {
      this.#record(now, percent);
      return true;
    }

    if (Math.abs(percent - this.#lastPercent) < this.options.minPercentDelta) return false;

    this.#record(now, percent);
    return true;
  }

  /** Forget the history so a new stage starts with an immediate update. */
  reset(): void {
    this.#lastEmittedAtMs = undefined;
    this.#lastPercent = undefined;
  }

  #record(atMs: number, percent: number | undefined): void {
    this.#lastEmittedAtMs = atMs;
    if (percent !== undefined) this.#lastPercent = percent;
  }
}
