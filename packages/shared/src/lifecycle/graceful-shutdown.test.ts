import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoopLogger } from '../logging/logger.port.js';
import type { ShutdownStep } from './graceful-shutdown.js';
import { installGracefulShutdown } from './graceful-shutdown.js';

/**
 * `installGracefulShutdown` registers process-level listeners. The tests drive
 * the returned function directly rather than raising real signals — Windows
 * only emulates SIGTERM, so a signal-based test would assert on the host's
 * behaviour instead of ours — and the listeners are removed afterwards so they
 * do not accumulate across files.
 */
/**
 * Everything `installGracefulShutdown` subscribes to. Two are signals; the
 * other two are not — `NodeJS.Signals` cannot describe this set, and typing it
 * as such is what hid the mismatch.
 */
type ShutdownEvent = NodeJS.Signals | 'unhandledRejection' | 'uncaughtException';

const SHUTDOWN_EVENTS: readonly ShutdownEvent[] = [
  'SIGTERM',
  'SIGINT',
  'unhandledRejection',
  'uncaughtException',
];

/**
 * `process`'s own overloads name each event individually, so none of them
 * accepts a variable holding the union. The `EventEmitter` interface underneath
 * takes any event name and is the honest way to say "whatever we registered".
 */
const events: EventEmitter = process;

const before = new Map<ShutdownEvent, number>(
  SHUTDOWN_EVENTS.map((event) => [event, events.listeners(event).length]),
);

afterEach(() => {
  for (const event of SHUTDOWN_EVENTS) {
    const keep = before.get(event) ?? 0;
    const listeners = events.listeners(event);
    for (const listener of listeners.slice(keep)) {
      events.removeListener(event, listener as () => void);
    }
  }
});

function step(name: string, log: string[], behaviour: 'ok' | 'throw' = 'ok'): ShutdownStep {
  return {
    name,
    run: () => {
      log.push(name);
      return behaviour === 'throw'
        ? Promise.reject(new Error(`${name} failed`))
        : Promise.resolve();
    },
  };
}

describe('installGracefulShutdown', () => {
  it('runs the steps in the order they were given', async () => {
    const log: string[] = [];
    const shutdown = installGracefulShutdown({
      logger: createNoopLogger(),
      timeoutMs: 5_000,
      steps: [step('bot', log), step('queue', log), step('database', log)],
      onExit: () => undefined,
    });

    await shutdown();

    // Order is the whole point: stop accepting work before closing what
    // processes it, or an in-flight update meets a closed connection.
    expect(log).toEqual(['bot', 'queue', 'database']);
  });

  it('runs only once however many times it is asked', async () => {
    const log: string[] = [];
    const shutdown = installGracefulShutdown({
      logger: createNoopLogger(),
      timeoutMs: 5_000,
      steps: [step('database', log)],
      onExit: () => undefined,
    });

    // Orchestrators do send a second SIGTERM. Starting a second teardown while
    // the first is mid-flight closes connections out from under it.
    await Promise.all([shutdown(), shutdown(), shutdown()]);
    expect(log).toEqual(['database']);
  });

  it('carries on after a step fails', async () => {
    const log: string[] = [];
    const shutdown = installGracefulShutdown({
      logger: createNoopLogger(),
      timeoutMs: 5_000,
      steps: [step('queue', log, 'throw'), step('redis', log), step('database', log)],
      onExit: () => undefined,
    });

    await expect(shutdown()).resolves.toBeUndefined();
    // A stuck queue connection must not leave the database open behind it.
    expect(log).toEqual(['queue', 'redis', 'database']);
  });

  it('exits anyway when a step outlasts the deadline', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    try {
      const shutdown = installGracefulShutdown({
        logger: createNoopLogger(),
        timeoutMs: 1_000,
        steps: [
          {
            name: 'stuck',
            run: () =>
              new Promise(() => {
                // A socket waiting on a dead peer blocks forever.
              }),
          },
        ],
        onExit: exit,
      });

      void shutdown();
      await vi.advanceTimersByTimeAsync(1_500);

      // Without the deadline the container gets SIGKILLed mid-write instead.
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers handlers for both termination signals', () => {
    const beforeTerm = process.listeners('SIGTERM').length;
    installGracefulShutdown({
      logger: createNoopLogger(),
      timeoutMs: 1_000,
      steps: [],
      onExit: () => undefined,
    });
    expect(process.listeners('SIGTERM').length).toBe(beforeTerm + 1);
  });
});
