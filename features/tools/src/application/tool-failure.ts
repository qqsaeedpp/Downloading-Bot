import type { ToolErrorCode } from '@tgtools/shared';
import {
  ToolErrorCode as Codes,
  describeError,
  isCancellation,
  isToolErrorCode,
  truncateForStorage,
} from '@tgtools/shared';

/**
 * One failure, reduced to a decision plus the two things worth recording.
 *
 * Deliberately NOT carrying the Persian sentence. Choosing words is the
 * presentation layer's job, and this module sits in `application/` — the lint
 * rule that enforces that caught the first draft, rightly. The caller renders
 * `faTools.failure(code)` at the point of display, which also means a future
 * second language changes nothing here.
 *
 * The two messages go to different places and must not be the same string. The
 * database gets a bounded, safe summary that an operator will later paste into
 * a ticket; the log gets everything.
 */
export interface ClassifiedToolFailure {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  /** For `tool_jobs.error_message_safe`. Bounded, and never third-party text. */
  readonly storedMessage: string;
  /** Full detail. For the log only — never the chat, never a column. */
  readonly logMessage: string;
}

/** The column has no length limit of its own, so one is imposed here. */
const STORED_MESSAGE_MAX = 300;

/**
 * What is written to the row when the failure was not one we modelled.
 *
 * An unmodelled error is third-party output — ffmpeg's stderr, a poppler dump,
 * an HTTP client echoing back a signed URL — and `error_message_safe` has no
 * expiry. Truncating would not help: the interesting secrets are at the front.
 * So the text is REPLACED, and the original goes to the log, which is not the
 * database.
 */
const UNMODELLED_STORED_MESSAGE = 'unmodelled failure; see the log for this request id';

/**
 * A `ToolError` from the engine, recognised structurally.
 *
 * Not by `instanceof`. Importing `@tgtools/file-tools-engine` to get the class
 * would load Sharp's native binding into the bot, which is the whole reason this
 * package does not depend on it. The shape is stable and the code is checked
 * against the shared vocabulary, so a foreign object that happens to carry a
 * `code` — a Postgres error carrying `23505`, say — is not mistaken for one.
 */
interface ToolErrorShape {
  readonly name: string;
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

function asToolError(error: unknown): ToolErrorShape | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as Partial<ToolErrorShape>;
  if (candidate.name !== 'ToolError') return undefined;
  if (typeof candidate.code !== 'string' || !isToolErrorCode(candidate.code)) return undefined;
  return {
    name: candidate.name,
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : '',
    // The engine lets one call site override the default table; honouring that
    // is the point of the flag existing.
    retryable: candidate.retryable === true,
  };
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'OperationTimeoutError' || name === 'TimeoutError';
}

/**
 * Turn whatever escaped a processor into a decision.
 *
 * Never throws. A classifier that fails while classifying turns a failed job
 * into a crashed worker, and a rejected promise can carry any value at all —
 * a string, `undefined`, a plain object.
 */
export function classifyToolFailure(error: unknown): ClassifiedToolFailure {
  const logMessage = describeError(error);

  // Cancellation first. It arrives both as our own `OperationCancelledError`
  // and as a bare `AbortError` from a child process that was killed, and
  // retrying either would re-run the exact work the user just stopped.
  if (isCancellation(error)) {
    return build(Codes.ToolCancelled, false, 'cancelled by the user', logMessage);
  }

  if (isTimeout(error)) {
    // Not retryable: the job hit the ceiling once, and a second attempt has the
    // same ceiling and the same file.
    return build(Codes.ToolTimeout, false, 'exceeded the time ceiling', logMessage);
  }

  const toolError = asToolError(error);
  if (toolError !== undefined) {
    // Our own message, so it is safe to store as written.
    return build(toolError.code, toolError.retryable, toolError.message, logMessage);
  }

  // Unrecognised: assume TRANSIENT, the opposite default from the modelled
  // codes. We know those are permanent; we do not know that about this one.
  return build(Codes.InternalError, true, UNMODELLED_STORED_MESSAGE, logMessage);
}

function build(
  code: ToolErrorCode,
  retryable: boolean,
  storedMessage: string,
  logMessage: string,
): ClassifiedToolFailure {
  return {
    code,
    retryable,
    storedMessage: truncateForStorage(storedMessage, STORED_MESSAGE_MAX),
    logMessage,
  };
}
