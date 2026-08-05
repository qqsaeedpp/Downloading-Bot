import {
  OperationCancelledError,
  OperationTimeoutError,
  ToolErrorCode,
  isToolErrorCode,
} from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { classifyToolFailure } from './tool-failure.js';

/**
 * A stand-in for the engine's `ToolError`.
 *
 * Constructed structurally rather than imported, because importing
 * `@tgtools/file-tools-engine` here would load Sharp's native binding into a
 * test about error classification — and would quietly re-introduce the
 * dependency this package exists to avoid.
 */
function toolError(code: ToolErrorCode, message: string, retryable?: boolean): Error {
  const error = new Error(message);
  error.name = 'ToolError';
  Object.assign(error, { code, retryable: retryable ?? false, context: {} });
  return error;
}

describe('classifyToolFailure', () => {
  it('keeps a modelled failure exactly as the engine reported it', () => {
    const failure = classifyToolFailure(toolError(ToolErrorCode.PdfEncrypted, 'PDF is encrypted'));

    expect(failure.code).toBe(ToolErrorCode.PdfEncrypted);
    expect(failure.retryable).toBe(false);
  });

  it('honours a retryable flag the engine set against the default table', () => {
    // `ToolErrorOptions.retryable` exists so one call site can know better than
    // the table. Ignoring it here would silently undo that.
    const failure = classifyToolFailure(
      toolError(ToolErrorCode.InvalidPdf, 'transient parse failure', true),
    );
    expect(failure.retryable).toBe(true);
  });

  it('recognises a cancellation and does not retry it', () => {
    // The single most expensive mistake available here: the user pressed
    // cancel, and BullMQ runs the whole conversion again anyway.
    const failure = classifyToolFailure(new OperationCancelledError('Cancelled by the user'));

    expect(failure.code).toBe(ToolErrorCode.ToolCancelled);
    expect(failure.retryable).toBe(false);
  });

  it('recognises a cancellation that arrived as a bare AbortError', () => {
    // `AbortController.abort()` with no reason produces this, and it reaches
    // the processor through ffmpeg's spawn rather than through our own code.
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';

    expect(classifyToolFailure(aborted).code).toBe(ToolErrorCode.ToolCancelled);
  });

  it('does not retry a timeout', () => {
    // The job hit the ceiling once; a second attempt has the same ceiling and
    // the same file, and on a shared worker it is capacity taken from a job
    // that would have finished.
    const failure = classifyToolFailure(new OperationTimeoutError(900_000, 'ffmpeg'));

    expect(failure.code).toBe(ToolErrorCode.ToolTimeout);
    expect(failure.retryable).toBe(false);
  });

  it('treats an unrecognised failure as internal AND retryable', () => {
    // The opposite default from the modelled codes: we do not know that this
    // one is permanent, and the modelled ones we do.
    const failure = classifyToolFailure(new Error('something nobody modelled'));

    expect(failure.code).toBe(ToolErrorCode.InternalError);
    expect(failure.retryable).toBe(true);
  });

  it('never stores the text of an unrecognised failure', () => {
    // This is the one that matters. An unmodelled error is third-party output —
    // ffmpeg stderr, a poppler dump, a driver message — and `error_message_safe`
    // is a column with no expiry that an operator will later paste into a
    // ticket. Modelled messages are ours and safe; this one is not, so it is
    // replaced rather than truncated.
    const failure = classifyToolFailure(
      new Error('ffmpeg: Server returned 403 for https://cdn.example/x?token=SECRET'),
    );

    expect(failure.storedMessage).not.toContain('SECRET');
    expect(failure.storedMessage).not.toContain('ffmpeg');
    expect(failure.storedMessage).not.toContain('https://');
    // The detail is not lost — it goes to the log, which is not the database.
    expect(failure.logMessage).toContain('403');
  });

  it('keeps a modelled message for storage, because we wrote it', () => {
    const failure = classifyToolFailure(toolError(ToolErrorCode.VideoTooLong, 'video is too long'));
    expect(failure.storedMessage).toBe('video is too long');
  });

  it('bounds what it stores, however long the message was', () => {
    // The column has no length limit of its own.
    const failure = classifyToolFailure(
      toolError(ToolErrorCode.ExternalToolFailed, 'x'.repeat(5_000)),
    );
    expect(failure.storedMessage.length).toBeLessThanOrEqual(300);
  });

  it('always lands on a code the message table can render', () => {
    // It does not choose the words — that is the presentation layer's job, and
    // the layering lint enforces it — but a code outside the vocabulary would
    // fall through `faTools.failure`'s exhaustive switch to `assertNever` and
    // throw while reporting a failure.
    for (const error of [
      toolError(ToolErrorCode.InvalidImage, 'bad image'),
      new OperationCancelledError('cancelled'),
      new OperationTimeoutError(1_000),
      new Error('unmodelled'),
      'not even an error',
      undefined,
    ]) {
      expect(isToolErrorCode(classifyToolFailure(error).code), String(error)).toBe(true);
    }
  });

  it('survives being handed something that is not an Error at all', () => {
    // A rejected promise can carry any value, and a classifier that throws
    // while classifying turns a failed job into a crashed worker.
    for (const thrown of [undefined, null, 'a string', 42, { code: 'nope' }]) {
      expect(() => classifyToolFailure(thrown), JSON.stringify(thrown)).not.toThrow();
      expect(classifyToolFailure(thrown).code).toBe(ToolErrorCode.InternalError);
    }
  });

  it('does not mistake a foreign object carrying a code for a ToolError', () => {
    // A Postgres error has a `code` too — `23505` for a unique violation. Reading
    // it as a tool error code would store a meaningless value and pick a Persian
    // sentence at random.
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(classifyToolFailure(pgError).code).toBe(ToolErrorCode.InternalError);
  });
});
