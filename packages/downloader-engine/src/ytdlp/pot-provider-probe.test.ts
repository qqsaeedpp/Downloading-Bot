import { describe, expect, it } from 'vitest';
import type { FetchLike } from './pot-provider-probe.js';
import { describePotProviderProblem, probePotProvider } from './pot-provider-probe.js';

const ok: FetchLike = () => Promise.resolve({ ok: true, status: 200 });

describe('probePotProvider', () => {
  it('says nothing when no provider is configured', async () => {
    // The default. Silence here is the whole point: most deployments run none.
    for (const value of [undefined, '', '   ']) {
      const status = await probePotProvider(value, ok);
      expect(status.kind, JSON.stringify(value)).toBe('not-configured');
      expect(describePotProviderProblem(status)).toBeUndefined();
    }
  });

  it('reports a healthy provider without complaint', async () => {
    const status = await probePotProvider('http://bgutil-provider:4416', ok);
    expect(status.kind).toBe('reachable');
    expect(describePotProviderProblem(status)).toBeUndefined();
  });

  it('asks for /ping on the configured base URL', async () => {
    const seen: string[] = [];
    const spy: FetchLike = (url) => {
      seen.push(url);
      return Promise.resolve({ ok: true, status: 200 });
    };

    await probePotProvider('http://bgutil-provider:4416', spy);
    expect(seen).toEqual(['http://bgutil-provider:4416/ping']);
  });

  it('does not produce a double slash when the URL ends in one', async () => {
    // `http://host:4416//ping` is a 404, which would be reported as "unhealthy"
    // for a service that is in fact running perfectly.
    const seen: string[] = [];
    const spy: FetchLike = (url) => {
      seen.push(url);
      return Promise.resolve({ ok: true, status: 200 });
    };

    await probePotProvider('http://bgutil-provider:4416///', spy);
    expect(seen).toEqual(['http://bgutil-provider:4416/ping']);
  });

  it('distinguishes a running-but-broken provider from an absent one', async () => {
    // Different remedies: read the container's logs, versus start the container.
    const unhealthy = await probePotProvider('http://p:4416', () =>
      Promise.resolve({ ok: false, status: 503 }),
    );
    expect(unhealthy).toEqual({ kind: 'unhealthy', status: 503 });
    expect(describePotProviderProblem(unhealthy)).toContain('503');

    const unreachable = await probePotProvider('http://p:4416', () =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    expect(unreachable.kind).toBe('unreachable');
    expect(describePotProviderProblem(unreachable)).toContain('ECONNREFUSED');
  });

  it('names localhost as the likely mistake, because it is', async () => {
    // Inside a container, `localhost` is that container. Pointing the variable
    // there reaches nothing, and the symptom is identical to a total block.
    const status = await probePotProvider('http://localhost:4416', () =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:4416')),
    );
    expect(describePotProviderProblem(status)).toContain('compose service name');
  });

  it('never puts the provider URL into the reported problem', async () => {
    // The URL is operator-supplied and can carry credentials.
    const status = await probePotProvider('http://user:hunter2@p:4416', () =>
      Promise.reject(new Error('nope')),
    );
    expect(describePotProviderProblem(status)).not.toContain('hunter2');
  });

  it('gives up rather than hanging the startup path', async () => {
    // A provider that accepts the connection and then says nothing must not
    // stop the bot from booting.
    const status = await probePotProvider(
      'http://p:4416',
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      10,
    );
    expect(status.kind).toBe('unreachable');
  });
});
