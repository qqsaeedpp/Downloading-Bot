/**
 * Time as a dependency. Injecting it is what makes expiry, throttling and
 * timeout logic testable without sleeping in a test.
 */
export interface Clock {
  /** Wall-clock instant. Always stored in UTC. */
  now(): Date;
  /** Monotonic milliseconds — safe for measuring elapsed time across a clock change. */
  monotonicMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    return performance.now();
  }
}

/** Test double: time only moves when the test says so. */
export class ManualClock implements Clock {
  #currentMs: number;

  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.#currentMs = start.getTime();
  }

  now(): Date {
    return new Date(this.#currentMs);
  }

  monotonicMs(): number {
    return this.#currentMs;
  }

  advance(ms: number): void {
    this.#currentMs += ms;
  }
}
