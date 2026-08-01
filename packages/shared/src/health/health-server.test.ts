import { afterEach, describe, expect, it } from 'vitest';
import { createNoopLogger } from '../logging/logger.port.js';
import type { HealthServer } from './health-server.js';
import { healthCheck, startHealthServer } from './health-server.js';

const started: HealthServer[] = [];

async function start(checks: Parameters<typeof startHealthServer>[0]['checks'], timeoutMs = 200) {
  const server = await startHealthServer({
    // Port 0 lets the OS pick a free one, so parallel test files cannot collide.
    port: 0,
    host: '127.0.0.1',
    service: 'test',
    version: '1.2.3',
    checks,
    logger: createNoopLogger(),
    checkTimeoutMs: timeoutMs,
  });
  started.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
});

describe('the health server', () => {
  it('reports liveness without consulting any dependency', async () => {
    const server = await start([
      healthCheck('never-called', () => Promise.reject(new Error('should not run'))),
    ]);

    const response = await fetch(`http://127.0.0.1:${server.port}/health/live`);
    expect(response.status).toBe(200);
    // Liveness must not depend on Postgres: an orchestrator would otherwise
    // restart a perfectly healthy container because a database blinked.
    expect(await response.json()).toMatchObject({
      status: 'ok',
      service: 'test',
      version: '1.2.3',
    });
  });

  it('reports ready when every check passes', async () => {
    const server = await start([
      healthCheck('postgres', () => Promise.resolve()),
      healthCheck('redis', () => Promise.resolve()),
    ]);

    const response = await fetch(`http://127.0.0.1:${server.port}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports 503 and names the failing dependency', async () => {
    const server = await start([
      healthCheck('postgres', () => Promise.resolve()),
      healthCheck('redis', () => Promise.reject(new Error('ECONNREFUSED'))),
    ]);

    const response = await fetch(`http://127.0.0.1:${server.port}/health/ready`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as { checks: { name: string; healthy: boolean }[] };
    expect(body.checks).toContainEqual(
      expect.objectContaining({ name: 'postgres', healthy: true }),
    );
    expect(body.checks).toContainEqual(expect.objectContaining({ name: 'redis', healthy: false }));
  });

  it('answers 503 rather than hanging when a check ignores its signal', async () => {
    // Regression guard. `db.execute` on a driver still retrying its connection
    // ignores the abort signal entirely, and `Promise.all` then never settles —
    // which turned readiness into a request that hung forever. A hanging probe
    // is strictly worse than a failing one: the orchestrator cannot act on it,
    // so the probe becomes the outage.
    const server = await start(
      [
        {
          name: 'stubborn',
          run: () =>
            new Promise(() => {
              // Deliberately never settles, and deliberately ignores the signal.
            }),
        },
      ],
      150,
    );

    const response = await fetch(`http://127.0.0.1:${server.port}/health/ready`, {
      signal: AbortSignal.timeout(3_000),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: { name: string; detail?: string }[] };
    expect(body.checks[0]?.name).toBe('stubborn');
    expect(body.checks[0]?.detail).toContain('did not answer');
  });

  it('answers 404 for anything else', async () => {
    const server = await start([]);
    const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(response.status).toBe(404);
  });
});
