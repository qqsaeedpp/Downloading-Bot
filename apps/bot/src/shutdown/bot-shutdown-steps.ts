import type { HealthServer, ShutdownStep } from '@tgtools/shared';
import type { BotContainer } from '../container.js';

/**
 * The bot's teardown, in order.
 *
 * Order is the whole point: stop accepting updates first, so nothing new
 * arrives, then close the things an in-flight update might still be using.
 * Reversing any pair here produces an update that meets a closed connection.
 */
export function buildBotShutdownSteps(
  container: BotContainer,
  health: HealthServer,
): readonly ShutdownStep[] {
  return [
    { name: 'telegram-polling', run: () => container.bot.stop() },
    { name: 'health-server', run: () => health.close() },
    { name: 'download-queue', run: () => container.downloadQueue.close() },
    { name: 'redis', run: () => container.redis.close() },
    { name: 'database', run: () => container.database.close() },
  ];
}
