import { AppError } from '../errors/app-error.js';

/** Someone asked for this to stop: a user tap, or a shutdown. */
export class OperationCancelledError extends AppError {
  readonly code = 'OPERATION_CANCELLED';
}

/** It ran too long. Carries the budget so the log line explains itself. */
export class OperationTimeoutError extends AppError {
  readonly code = 'OPERATION_TIMEOUT';

  constructor(
    readonly timeoutMs: number,
    label = 'operation',
  ) {
    super(`${label} exceeded its ${timeoutMs}ms budget`, { context: { timeoutMs, label } });
  }
}

export interface AbortScope {
  readonly signal: AbortSignal;
  /** Abort early — the watchdog tripping, or a user pressing cancel. */
  abort(reason: Error): void;
  /**
   * Release the timer and the parent listener. Always call it in a `finally`:
   * a forgotten listener on a long-lived parent signal is a slow leak.
   */
  dispose(): void;
}

export interface AbortScopeOptions {
  readonly parent?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly label?: string | undefined;
}

/**
 * Compose a per-step cancellation scope from an optional parent signal and an
 * optional deadline.
 *
 * Built by hand rather than with `AbortSignal.any` because the reason matters:
 * a timeout and a cancellation lead to different user-facing messages and
 * different retry decisions, and `any` forwards whatever the first signal
 * carried without letting us attach our own.
 */
export function createAbortScope(options: AbortScopeOptions = {}): AbortScope {
  const { parent, timeoutMs, label } = options;
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];

  const abort = (reason: Error): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (parent !== undefined) {
    if (parent.aborted) {
      abort(toAbortError(parent.reason));
    } else {
      const onParentAbort = (): void => {
        abort(toAbortError(parent.reason));
      };
      parent.addEventListener('abort', onParentAbort, { once: true });
      cleanups.push(() => {
        parent.removeEventListener('abort', onParentAbort);
      });
    }
  }

  if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
    const timer = setTimeout(() => {
      abort(new OperationTimeoutError(timeoutMs, label ?? 'operation'));
    }, timeoutMs);
    timer.unref();
    cleanups.push(() => {
      clearTimeout(timer);
    });
  }

  return {
    signal: controller.signal,
    abort,
    dispose(): void {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}

/** Normalise whatever a signal carried into an `Error` we can classify. */
export function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new OperationCancelledError('Operation was aborted', { cause: reason });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw toAbortError(signal.reason);
}

export function isTimeoutAbort(reason: unknown): boolean {
  return reason instanceof OperationTimeoutError;
}

export function isCancellation(reason: unknown): boolean {
  return (
    reason instanceof OperationCancelledError ||
    (reason instanceof Error && reason.name === 'AbortError')
  );
}

/** Sleep that actually stops when the signal fires, instead of resolving late. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(toAbortError(signal.reason));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Race a promise against a deadline. Note the promise itself keeps running —
 * only use this where the underlying work has no signal of its own and the
 * leak is bounded.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'operation',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new OperationTimeoutError(timeoutMs, label));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
