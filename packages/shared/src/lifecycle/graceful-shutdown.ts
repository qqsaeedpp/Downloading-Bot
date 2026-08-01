import { describeError } from '../errors/app-error.js';
import type { Logger } from '../logging/logger.port.js';

export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface GracefulShutdownOptions {
  readonly logger: Logger;
  readonly steps: readonly ShutdownStep[];
  /** After this, the process exits whatever is still hanging. */
  readonly timeoutMs: number;
  /** Overridden in tests so a shutdown assertion does not kill the runner. */
  readonly onExit?: (code: number) => void;
}

/**
 * Runs shutdown steps in order, once, with a hard deadline.
 *
 * Three properties matter, and each comes from a way this goes wrong:
 * a second SIGTERM — which orchestrators do send — must not start a second
 * teardown; one failing step must not skip the rest, or a stuck queue
 * connection leaves the database open behind it; and the whole thing needs a
 * deadline, because a socket waiting on a dead peer blocks forever and gets the
 * container SIGKILLed mid-write instead of closed cleanly.
 */
export function installGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  const { logger, steps, timeoutMs } = options;
  let shuttingDown: Promise<void> | undefined;

  const exit = options.onExit ?? ((code: number) => process.exit(code));

  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown !== undefined) {
      logger.debug('shutdown already in progress', { reason });
      return shuttingDown;
    }

    shuttingDown = (async () => {
      logger.info('shutting down', { reason, steps: steps.length });

      const deadline = setTimeout(() => {
        logger.error('shutdown exceeded its deadline; exiting anyway', { timeoutMs });
        exit(1);
      }, timeoutMs);
      deadline.unref();

      for (const step of steps) {
        try {
          await step.run();
          logger.debug('shutdown step completed', { step: step.name });
        } catch (error: unknown) {
          logger.error('shutdown step failed', { step: step.name, error: describeError(error) });
        }
      }

      clearTimeout(deadline);
      logger.info('shutdown complete');
    })();

    return shuttingDown;
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal).then(() => {
        exit(0);
      });
    });
  }

  // A rejection nobody handled leaves the process in a state nobody reasoned
  // about. Shutting down and letting the orchestrator restart is safer than
  // carrying on with a broken invariant.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal('unhandled promise rejection', { error: describeError(reason) });
    void shutdown('unhandledRejection').then(() => {
      exit(1);
    });
  });

  process.on('uncaughtException', (error: Error) => {
    logger.fatal('uncaught exception', { error: describeError(error) });
    void shutdown('uncaughtException').then(() => {
      exit(1);
    });
  });

  return () => shutdown('manual');
}
