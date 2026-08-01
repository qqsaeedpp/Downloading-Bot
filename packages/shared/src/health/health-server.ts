import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { describeError } from '../errors/app-error.js';
import type { Logger } from '../logging/logger.port.js';

export interface HealthCheckResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly detail?: string | undefined;
}

/**
 * A readiness probe. Named, so that a timeout can still say which dependency
 * failed to answer — `check-2` tells an operator nothing at 3 a.m.
 */
export interface HealthCheck {
  readonly name: string;
  run(signal: AbortSignal): Promise<HealthCheckResult>;
}

export interface HealthServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly service: string;
  readonly version: string;
  readonly checks: readonly HealthCheck[];
  readonly logger: Logger;
  /** Budget for each individual check. */
  readonly checkTimeoutMs?: number;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Liveness answers "is the process running"; readiness answers "can it do its
 * job". Keeping them separate is what stops an orchestrator from restarting a
 * perfectly healthy container because Postgres blinked.
 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const { port, host = '0.0.0.0', service, version, checks, logger } = options;
  const checkTimeoutMs = options.checkTimeoutMs ?? 5_000;
  const startedAt = Date.now();

  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/';
    const respond = (status: number, body: unknown): void => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };

    if (url === '/health/live') {
      respond(200, { status: 'ok', service, version, uptimeSeconds: uptime(startedAt) });
      return;
    }

    if (url === '/health/ready') {
      void runChecks(checks, checkTimeoutMs).then(
        (results) => {
          const healthy = results.every((result) => result.healthy);
          respond(healthy ? 200 : 503, {
            status: healthy ? 'ok' : 'degraded',
            service,
            version,
            uptimeSeconds: uptime(startedAt),
            checks: results,
          });
        },
        (error: unknown) => {
          logger.error('readiness probe failed', { error: describeError(error) });
          respond(503, { status: 'error', service, version });
        },
      );
      return;
    }

    respond(404, { status: 'not_found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // The bound port, not the requested one: passing 0 asks the OS to pick a free
  // one, and the caller has no other way to find out which.
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  logger.info('health server listening', { service, port: boundPort, host });

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        // Long-lived keep-alive sockets would otherwise hold shutdown open.
        server.closeAllConnections();
      }),
  };
}

/**
 * Run every check, bounded.
 *
 * The signal is handed to each probe, but the deadline does NOT rely on it
 * being honoured: `db.execute` on a driver still retrying its connection
 * ignores the signal entirely, and `Promise.all` then never settles. That turns
 * readiness into a hanging request, which is strictly worse than a 503 — an
 * orchestrator waiting for an answer cannot act, so the probe itself becomes
 * the outage.
 *
 * Each check is therefore *raced* against the deadline. The abandoned promise
 * is left to settle on its own; nothing in the response depends on it.
 */
async function runChecks(
  checks: readonly HealthCheck[],
  timeoutMs: number,
): Promise<HealthCheckResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('health check timeout'));
  }, timeoutMs);
  timer.unref();

  try {
    return await Promise.all(
      checks.map(async (check) => {
        try {
          return await Promise.race([
            check.run(controller.signal),
            deadline(timeoutMs, check.name),
          ]);
        } catch (error: unknown) {
          return {
            name: check.name,
            healthy: false,
            detail: describeError(error),
          } satisfies HealthCheckResult;
        }
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

function deadline(timeoutMs: number, name: string): Promise<HealthCheckResult> {
  return new Promise<HealthCheckResult>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ name, healthy: false, detail: `did not answer within ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();
  });
}

function uptime(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

/** Wrap an async probe into a named check that reports failure instead of throwing. */
export function healthCheck(
  name: string,
  probe: (signal: AbortSignal) => Promise<void>,
): HealthCheck {
  return {
    name,
    async run(signal) {
      try {
        await probe(signal);
        return { name, healthy: true };
      } catch (error: unknown) {
        return { name, healthy: false, detail: describeError(error) };
      }
    },
  };
}
