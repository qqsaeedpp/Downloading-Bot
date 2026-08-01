import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OperationCancelledError,
  OperationTimeoutError,
  createAbortScope,
  delay,
  isCancellation,
  isTimeoutAbort,
  throwIfAborted,
} from './cancellation.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAbortScope', () => {
  it('starts unaborted when given neither a parent nor a timeout', () => {
    const scope = createAbortScope();

    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  it('is already aborted when the parent signal was aborted before the scope existed', () => {
    const parent = new AbortController();
    const reason = new OperationCancelledError('user tapped cancel');
    parent.abort(reason);

    const scope = createAbortScope({ parent: parent.signal });

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe(reason);
    scope.dispose();
  });

  it('wraps a non-Error parent reason into an OperationCancelledError', () => {
    const parent = new AbortController();
    parent.abort('shutting down');

    const scope = createAbortScope({ parent: parent.signal });

    expect(scope.signal.reason).toBeInstanceOf(OperationCancelledError);
    expect(isCancellation(scope.signal.reason)).toBe(true);
    scope.dispose();
  });

  it('propagates an abort that happens after the scope was created', () => {
    const parent = new AbortController();
    const scope = createAbortScope({ parent: parent.signal });
    expect(scope.signal.aborted).toBe(false);

    const reason = new OperationCancelledError('worker shutdown');
    parent.abort(reason);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe(reason);
    scope.dispose();
  });

  it('classifies the default abort reason as a cancellation', () => {
    const parent = new AbortController();
    const scope = createAbortScope({ parent: parent.signal });

    parent.abort();

    expect(isCancellation(scope.signal.reason)).toBe(true);
    scope.dispose();
  });

  it('aborts with an OperationTimeoutError once the budget elapses', () => {
    const scope = createAbortScope({ timeoutMs: 5_000, label: 'download' });

    vi.advanceTimersByTime(4_999);
    expect(scope.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBeInstanceOf(OperationTimeoutError);
    expect(isTimeoutAbort(scope.signal.reason)).toBe(true);
    const reason: unknown = scope.signal.reason;
    expect(reason instanceof OperationTimeoutError ? reason.timeoutMs : undefined).toBe(5_000);
    expect(reason instanceof Error ? reason.message : '').toContain('download');
    scope.dispose();
  });

  it('does not arm a timer for a non-positive timeout', () => {
    const scope = createAbortScope({ timeoutMs: 0 });

    vi.advanceTimersByTime(60_000);

    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  it('keeps the first reason when abort() is called twice', () => {
    const scope = createAbortScope();
    const first = new OperationCancelledError('first');
    scope.abort(first);
    scope.abort(new OperationCancelledError('second'));

    expect(scope.signal.reason).toBe(first);
    scope.dispose();
  });

  it('dispose() detaches the parent listener so a later parent abort does nothing', () => {
    const parent = new AbortController();
    const scope = createAbortScope({ parent: parent.signal });

    scope.dispose();
    parent.abort(new OperationCancelledError('too late'));

    expect(scope.signal.aborted).toBe(false);
  });

  it('dispose() clears the timeout so the deadline can no longer fire', () => {
    const scope = createAbortScope({ timeoutMs: 1_000 });

    scope.dispose();
    vi.advanceTimersByTime(10_000);

    expect(scope.signal.aborted).toBe(false);
  });

  it('is safe to dispose twice', () => {
    const parent = new AbortController();
    const scope = createAbortScope({ parent: parent.signal, timeoutMs: 1_000 });

    scope.dispose();
    expect(() => {
      scope.dispose();
    }).not.toThrow();
  });

  it('prefers the parent reason when the parent aborts before the deadline', () => {
    const parent = new AbortController();
    const scope = createAbortScope({ parent: parent.signal, timeoutMs: 10_000 });

    const reason = new OperationCancelledError('user cancelled');
    parent.abort(reason);
    vi.advanceTimersByTime(20_000);

    expect(scope.signal.reason).toBe(reason);
    expect(isTimeoutAbort(scope.signal.reason)).toBe(false);
    scope.dispose();
  });
});

describe('delay', () => {
  it('resolves once the requested time has passed', async () => {
    const pending = delay(1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    const controller = new AbortController();
    const reason = new OperationCancelledError('already gone');
    controller.abort(reason);

    await expect(delay(1_000, controller.signal)).rejects.toBe(reason);
  });

  it('rejects as soon as its signal aborts, without waiting out the delay', async () => {
    const controller = new AbortController();
    const pending = delay(60_000, controller.signal);
    const reason = new OperationCancelledError('stop now');

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('still resolves normally when its signal never aborts', async () => {
    const controller = new AbortController();
    const pending = delay(50, controller.signal);

    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBeUndefined();
  });
});

describe('isTimeoutAbort', () => {
  it('recognises an OperationTimeoutError', () => {
    expect(isTimeoutAbort(new OperationTimeoutError(1_000, 'upload'))).toBe(true);
  });

  it('rejects a cancellation, a plain error and undefined', () => {
    expect(isTimeoutAbort(new OperationCancelledError('nope'))).toBe(false);
    expect(isTimeoutAbort(new Error('boom'))).toBe(false);
    expect(isTimeoutAbort(undefined)).toBe(false);
  });
});

describe('isCancellation', () => {
  it('recognises an OperationCancelledError', () => {
    expect(isCancellation(new OperationCancelledError('stopped'))).toBe(true);
  });

  it('recognises any error whose name is AbortError', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';

    expect(isCancellation(error)).toBe(true);
  });

  it('does not treat a timeout or an arbitrary error as a cancellation', () => {
    expect(isCancellation(new OperationTimeoutError(1_000))).toBe(false);
    expect(isCancellation(new Error('disk full'))).toBe(false);
    expect(isCancellation('cancelled')).toBe(false);
  });
});

describe('throwIfAborted', () => {
  it('does nothing when there is no signal', () => {
    expect(() => {
      throwIfAborted(undefined);
    }).not.toThrow();
  });

  it('does nothing while the signal is still live', () => {
    const controller = new AbortController();

    expect(() => {
      throwIfAborted(controller.signal);
    }).not.toThrow();
  });

  it('throws the reason the signal carries', () => {
    const controller = new AbortController();
    const reason = new OperationCancelledError('cancelled by user');
    controller.abort(reason);

    expect(() => {
      throwIfAborted(controller.signal);
    }).toThrow(reason);
  });

  it('throws an OperationCancelledError when the reason is not an Error', () => {
    const controller = new AbortController();
    controller.abort('some string');

    expect(() => {
      throwIfAborted(controller.signal);
    }).toThrow(OperationCancelledError);
  });
});
