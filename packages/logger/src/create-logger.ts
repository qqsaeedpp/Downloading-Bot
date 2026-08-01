import type { AppConfig } from '@tgtools/config';
import type { LogContext, Logger } from '@tgtools/shared';
import pino from 'pino';
import type { DestinationStream, Logger as PinoLogger, LoggerOptions } from 'pino';
import { REDACTED_PATHS, scrubText } from './redaction.js';

export interface CreateLoggerOptions {
  readonly config: AppConfig;
  /** Goes on every line, e.g. `bot` or `worker`. */
  readonly service: string;
  /** Overrides the destination; used by tests to capture output. */
  readonly destination?: DestinationStream;
}

/**
 * Build the process logger. Pino stays behind {@link Logger} so that use cases,
 * policies and mappers can be tested with a fake and never learn what a
 * transport is.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { config, service } = options;

  const pinoOptions: LoggerOptions = {
    level: config.logging.level,
    base: {
      service,
      version: config.version,
      env: config.environment,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Errors are serialised in full — including the cause chain — because the
    // internal log is the only place the raw failure is allowed to appear.
    serializers: {
      error: pino.stdSerializers.err,
      err: pino.stdSerializers.err,
    },
    // pino-pretty spawns a worker thread, which is fine for a terminal and
    // wasteful in production, where the runtime should collect JSON on stdout.
    ...(config.logging.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };

  const root =
    options.destination === undefined ? pino(pinoOptions) : pino(pinoOptions, options.destination);

  return adapt(root);
}

function adapt(instance: PinoLogger): Logger {
  const write =
    (level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') =>
    (message: string, context?: LogContext): void => {
      const safeMessage = scrubText(message);
      if (context === undefined) instance[level](safeMessage);
      else instance[level](context, safeMessage);
    };

  return {
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: (context: LogContext) => adapt(instance.child(context)),
  };
}
