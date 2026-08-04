import { autoRetry } from '@grammyjs/auto-retry';
import type { AppConfig } from '@tgtools/config';
import type { Logger } from '@tgtools/shared';
import { Api, Bot } from 'grammy';
import { PUBLIC_BOT_API_ROOT } from './api-root.js';
import type { AppContext } from './context.js';

/**
 * grammY's `autoRetry` waits out a 429 for us, up to a bounded number of
 * attempts. Without a `maxDelaySeconds` cap a punitive `retry_after` could park
 * a worker slot for an hour; without `maxRetryAttempts` a permanently throttled
 * chat would hold it forever.
 */
const AUTO_RETRY = {
  maxRetryAttempts: 3,
  maxDelaySeconds: 30,
  retryOnInternalServerErrors: true,
} as const;

export interface CreateBotOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
}

/**
 * The single place a Telegram client is configured, for both processes.
 *
 * A local Bot API server is selected by `apiRoot` and NOTHING else. grammY's
 * `environment` option accepts only `prod` and `test`; setting it to anything
 * resembling "local" is not a supported value and would be rejected — the fact
 * that the two look interchangeable is exactly why this is written down once.
 */
export function resolveApiRoot(config: AppConfig): string {
  return (config.telegram.apiRoot ?? PUBLIC_BOT_API_ROOT).replace(/\/+$/, '');
}

export function createBot({ config, logger }: CreateBotOptions): Bot<AppContext> {
  const bot = new Bot<AppContext>(config.telegram.botToken, {
    client: { apiRoot: resolveApiRoot(config) },
  });

  bot.api.config.use(autoRetry(AUTO_RETRY));
  logger.debug('telegram bot client created', {
    apiRoot: resolveApiRoot(config),
    localApi: config.telegram.useLocalApi,
  });
  return bot;
}

/**
 * A bare API client for processes that send but never receive — the worker
 * pushes progress edits and the finished file, and must not also be polling for
 * updates.
 */
export function createTelegramApi({ config }: { config: AppConfig }): Api {
  // Resolved through the same helper as the bot's client. The two processes
  // disagreeing about where Telegram is produces the worst symptom in this
  // system: the bot lists qualities the worker then cannot deliver.
  const api = new Api(config.telegram.botToken, { apiRoot: resolveApiRoot(config) });
  api.config.use(autoRetry(AUTO_RETRY));
  return api;
}
