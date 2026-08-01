export interface AppErrorOptions {
  readonly cause?: unknown;
  /**
   * Structured detail for the log line. Must never carry a secret — this object
   * is serialised verbatim by the logger.
   */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Root of every error this codebase raises deliberately. A stable `code` lets
 * callers branch on the failure without matching on a message that a library
 * upgrade may reword.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;

  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.context = options.context ?? {};
    Error.captureStackTrace(this, new.target);
  }
}

/** A bug: a state the code claimed was impossible. */
export class InvariantViolationError extends AppError {
  readonly code = 'INVARIANT_VIOLATION';
}

/** Configuration or wiring is wrong — the process cannot usefully continue. */
export class ConfigurationError extends AppError {
  readonly code = 'CONFIGURATION_ERROR';
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Message text for a log line, never for a user. Narrows `unknown` without
 * stringifying an object into "[object Object]".
 */
export function describeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Proves a switch covered every member of a union. Reaching it at runtime means
 * a new variant was added without updating the switch.
 */
export function assertNever(value: never, what = 'value'): never {
  throw new InvariantViolationError(`Unhandled ${what}: ${String(value)}`);
}
