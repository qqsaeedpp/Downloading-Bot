import { autoRetry } from '@grammyjs/auto-retry';
import type { AppConfig } from '@tgtools/config';
import type { Logger } from '@tgtools/shared';
import { Api, Bot } from 'grammy';
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

export function createBot({ config, logger }: CreateBotOptions): Bot<AppContext> {
  const bot = new Bot<AppContext>(config.telegram.botToken, {
    client: config.telegram.apiRoot === undefined ? {} : { apiRoot: config.telegram.apiRoot },
  });

  bot.api.config.use(autoRetry(AUTO_RETRY));
  logger.debug('telegram bot client created', {
    apiRoot: config.telegram.apiRoot ?? 'default',
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
  const api = new Api(
    config.telegram.botToken,
    config.telegram.apiRoot === undefined ? {} : { apiRoot: config.telegram.apiRoot },
  );
  api.config.use(autoRetry(AUTO_RETRY));
  return api;
}
