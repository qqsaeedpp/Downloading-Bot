import { ToolErrorCode, isRetryableToolError } from '@tgtools/shared';

/**
 * Two audiences, deliberately separated. The CODE drives behaviour — whether to
 * retry, what to tell the user, which metric to move — and the raw cause stays
 * in the log. A user who sends a corrupt PDF should read one clear sentence in
 * Persian, not a poppler stack trace; and an operator debugging the same event
 * needs the stack trace, not the sentence.
 *
 * The vocabulary itself moved to `@tgtools/shared`, and is re-exported here so
 * that every existing import still resolves. It had to move because the bot
 * translates these codes into Persian and the bot must never load this package —
 * importing it pulls in Sharp's native binding, which is 40 MB of libvips in the
 * one process that has no pixels to decode.
 */
export { ToolErrorCode, isRetryableToolError };

export interface ToolErrorOptions {
  /** Structured, already-safe context for the log. Never raw tool output. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Overrides the table above when one call site knows better. */
  readonly retryable?: boolean;
}

/**
 * The only error type the processors throw.
 *
 * `message` is for the log and is never shown to a user — the presentation
 * layer maps {@link code} to Persian text. Keeping the two apart is what stops
 * an ffmpeg stderr line reaching a chat window.
 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ToolErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolError';
    this.code = code;
    this.retryable = options.retryable ?? isRetryableToolError(code);
    this.context = options.context ?? {};
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

/**
 * Wrap anything that escaped a processor.
 *
 * An unrecognised failure becomes `INTERNAL_ERROR` and is retryable, on the
 * reasoning that we do not know it is permanent — the opposite default from the
 * modelled codes, where we do.
 */
export function toToolError(error: unknown, fallbackMessage = 'tool failed'): ToolError {
  if (isToolError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(ToolErrorCode.InternalError, `${fallbackMessage}: ${message}`, {
    cause: error,
  });
}
