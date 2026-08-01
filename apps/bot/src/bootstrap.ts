import { loadConfig } from '@tgtools/config';
import {
  describeError,
  healthCheck,
  installGracefulShutdown,
  startHealthServer,
} from '@tgtools/shared';
import { createBotContainer } from './container.js';
import { createErrorBoundary } from './middleware/error-boundary.js';
import { rateLimit } from './middleware/rate-limit.middleware.js';
import { requestContext } from './middleware/request-context.middleware.js';
import { userContext } from './middleware/user.middleware.js';
import { registerFeatures } from './register-features.js';
import { buildBotShutdownSteps } from './shutdown/bot-shutdown-steps.js';

/**
 * The bot process.
 *
 * It receives updates, answers questions and puts work on a queue. It never
 * downloads, never runs FFmpeg and never writes a media file — a single 400 MB
 * pull in here would block every other user's update for as long as it ran.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createBotContainer(config);
  const { logger, bot } = container;

  // `version` and `env` are already on every line via the logger's base
  // bindings; repeating them here would emit a duplicated JSON key.
  logger.info('starting bot', { node: process.version });

  // Middleware order is the security order: identity before rate limiting,
  // rate limiting before anything that costs time or money.
  bot.use(requestContext({ logger, ids: container.ids }));
  bot.use(
    rateLimit({
      redis: container.redis.client,
      windowMs: config.limits.rateLimitWindowMs,
      maxRequests: config.limits.rateLimitMaxRequests,
    }),
  );
  bot.use(userContext({ registerOrUpdateUser: container.registerOrUpdateUser }));

  const { commands } = registerFeatures(container);
  bot.catch(createErrorBoundary(logger));

  const health = await startHealthServer({
    port: config.health.botPort,
    service: 'bot',
    version: config.version,
    logger,
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
    ],
  });

  installGracefulShutdown({
    logger,
    timeoutMs: 20_000,
    steps: buildBotShutdownSteps(container, health),
  });

  await bot.api.setMyCommands([...commands]);

  // `start` resolves only once the bot stops, so awaiting it here would mean
  // shutdown never gets a turn.
  void bot.start({
    // Only the update types the features handle; anything else costs a round
    // trip and a middleware pass for nothing.
    allowed_updates: ['message', 'callback_query'],
    onStart: (info) => {
      logger.info('bot is listening', { username: info.username, id: info.id });
    },
  });
}

main().catch((error: unknown) => {
  // Nothing is wired yet, so there is no logger and no shutdown to run. Write
  // to stderr and let the orchestrator see the non-zero exit.
  process.stderr.write(`fatal: bot failed to start: ${describeError(error)}\n`);
  process.exit(1);
});
