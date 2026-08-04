import type { AppConfig } from '@tgtools/config';
import { createNoopLogger } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { createBot, createTelegramApi } from './bot-factory.js';

const TOKEN = '123456789:AAEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE';
const LOCAL_ROOT = 'http://telegram-bot-api:8081';

/**
 * Only the fields the factory reads. Cast at the boundary because building a
 * whole AppConfig here would couple this test to every unrelated setting.
 */
function config(telegram: { apiRoot?: string; useLocalApi?: boolean }): AppConfig {
  return {
    telegram: {
      botToken: TOKEN,
      apiRoot: telegram.apiRoot,
      useLocalApi: telegram.useLocalApi ?? false,
    },
  } as unknown as AppConfig;
}

/**
 * grammY keeps the resolved root on the `Api` instance's `options`, which is not
 * part of its public type. Read through one narrow accessor so that if a future
 * grammY moves it, exactly one line fails rather than every assertion.
 */
function optionsOf(api: unknown): Record<string, unknown> {
  const holder = api as { options?: Record<string, unknown> };
  return holder.options ?? {};
}

describe('the shared Telegram client factory', () => {
  it('points the BOT at a local Bot API server when one is configured', async () => {
    const bot = createBot({
      config: config({ apiRoot: LOCAL_ROOT, useLocalApi: true }),
      logger: createNoopLogger(),
    });
    expect(optionsOf(bot.api)['apiRoot']).toBe(LOCAL_ROOT);
    await bot.stop().catch(() => undefined);
  });

  it('points the WORKER at the same server, from the same configuration', async () => {
    // The two processes disagreeing is the failure this factory exists to
    // prevent: the bot would list qualities the worker could not deliver.
    const api = createTelegramApi({ config: config({ apiRoot: LOCAL_ROOT, useLocalApi: true }) });
    expect(optionsOf(api)['apiRoot']).toBe(LOCAL_ROOT);
    await Promise.resolve();
  });

  it('leaves both on the public API when no root is configured', async () => {
    // Local mode is opt-in. An unset root must keep the existing public
    // behaviour rather than silently pointing somewhere else.
    const bot = createBot({ config: config({}), logger: createNoopLogger() });
    const api = createTelegramApi({ config: config({}) });

    for (const client of [bot.api, api]) {
      const root = optionsOf(client)['apiRoot'];
      expect(root === undefined || String(root).includes('api.telegram.org')).toBe(true);
    }
    await bot.stop().catch(() => undefined);
  });

  it("never sets grammY's `environment`, which knows only prod and test", async () => {
    // A local server is selected by `apiRoot` alone. Passing
    // `environment: "local"` is not a supported value and would be rejected.
    const bot = createBot({
      config: config({ apiRoot: LOCAL_ROOT, useLocalApi: true }),
      logger: createNoopLogger(),
    });
    expect(optionsOf(bot.api)['environment']).toBeUndefined();
    await bot.stop().catch(() => undefined);
  });
});
