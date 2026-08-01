import { OperationCancelledError, OperationTimeoutError, describeError } from '@tgtools/shared';
import { EngineError, EngineFailureCode } from './engine-error.js';
import { YTDLP_ERROR_PATTERNS } from './ytdlp-error-patterns.js';

export interface YtDlpFailure {
  /** Non-zero exit code, or null when the process was killed by a signal. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly cause?: unknown;
}

/**
 * Turn a yt-dlp failure into a typed engine error.
 *
 * Classification uses, in order of trust: how the process ended (a signal we
 * sent is unambiguous), then the exit code, then the message text. Text is the
 * last resort precisely because it is the least stable input.
 */
export class YtDlpErrorMapper {
  map(failure: YtDlpFailure): EngineError {
    const stderr = failure.stderr.trim();

    // We killed it. Which of our watchdogs did so is already encoded in the
    // abort reason, so trust that over anything yt-dlp managed to print.
    if (failure.cause instanceof OperationTimeoutError) {
      return new EngineError(EngineFailureCode.DownloadTimeout, failure.cause.message, {
        cause: failure.cause,
      });
    }
    if (failure.cause instanceof EngineError) return failure.cause;
    if (failure.cause instanceof OperationCancelledError) {
      return new EngineError(EngineFailureCode.Cancelled, 'Download was cancelled', {
        cause: failure.cause,
      });
    }

    for (const { code, pattern } of YTDLP_ERROR_PATTERNS) {
      if (pattern.test(stderr)) {
        return new EngineError(code, summarise(stderr), {
          context: { exitCode: failure.exitCode, signal: failure.signal },
        });
      }
    }

    // SIGKILL with nothing useful on stderr is what an OOM kill looks like.
    if (failure.signal === 'SIGKILL' || failure.signal === 'SIGTERM') {
      return new EngineError(
        EngineFailureCode.DownloadFailed,
        `yt-dlp was terminated by ${failure.signal}`,
        { context: { signal: failure.signal }, retryable: true },
      );
    }

    return new EngineError(
      EngineFailureCode.DownloadFailed,
      stderr === '' ? `yt-dlp exited with code ${String(failure.exitCode)}` : summarise(stderr),
      { context: { exitCode: failure.exitCode }, cause: failure.cause },
    );
  }

  /** For a rejection that never produced a structured failure. */
  mapUnknown(
    error: unknown,
    fallback: EngineFailureCode = EngineFailureCode.DownloadFailed,
  ): EngineError {
    if (error instanceof EngineError) return error;
    if (error instanceof OperationTimeoutError) {
      return new EngineError(EngineFailureCode.DownloadTimeout, error.message, { cause: error });
    }
    if (error instanceof OperationCancelledError) {
      return new EngineError(EngineFailureCode.Cancelled, error.message, { cause: error });
    }
    const message = describeError(error);
    for (const { code, pattern } of YTDLP_ERROR_PATTERNS) {
      if (pattern.test(message)) return new EngineError(code, summarise(message), { cause: error });
    }
    return new EngineError(fallback, summarise(message), { cause: error });
  }
}

/**
 * Keep the last few `ERROR:` lines and drop the rest. yt-dlp's stderr can run to
 * megabytes of warnings, and it echoes full request URLs — cookies included —
 * which must not end up in a stored error field.
 */
function summarise(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const errorLines = lines.filter((line) => /^(ERROR|WARNING):/i.test(line));
  const chosen = (errorLines.length > 0 ? errorLines : lines).slice(-3).join(' | ');
  return chosen.length > 400 ? `${chosen.slice(0, 399)}…` : chosen;
}
