export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Structured detail attached to a log line. */
export type LogContext = Readonly<Record<string, unknown>>;

/**
 * The logging contract the whole codebase programs against. Pino lives behind
 * it in `@tgtools/logger`; nothing above infrastructure ever names Pino, so a
 * use case stays testable with a three-line fake.
 */
export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  /** A logger that stamps every line with `context`, for per-job correlation. */
  child(context: LogContext): Logger;
}

/** Discards everything. For tests and for the rare "logging is optional" path. */
export function createNoopLogger(): Logger {
  const noop = (): void => {
    // Intentionally empty: this logger exists to swallow output.
  };
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}
