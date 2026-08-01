import { createHelpFeature } from '@tgtools/feature-help';
import { createStartFeature } from '@tgtools/feature-start';
import { bytesToMegabytes } from '@tgtools/shared';
import type { BotFeature, FeatureCommand } from '@tgtools/telegram';
import type { BotContainer } from './container.js';

/**
 * The feature list.
 *
 * This is the entire cost of adding the next tool to the bot: build a
 * `BotFeature` and append it here. Order matters — grammY runs composers in
 * sequence, so command features go before the catch-all link handler, which
 * otherwise treats a command's argument as a URL.
 */
export function registerFeatures(container: BotContainer): {
  readonly features: readonly BotFeature[];
  readonly commands: readonly FeatureCommand[];
} {
  const features: BotFeature[] = [
    createStartFeature(),
    createHelpFeature({
      maxUploadMegabytes: Math.floor(bytesToMegabytes(container.config.limits.maxUploadBytes)),
    }),
    container.downloader.botFeature,
  ];

  for (const feature of features) {
    container.bot.use(feature.composer);
    container.logger.debug('feature registered', { feature: feature.name });
  }

  const commands = features.flatMap((feature) => feature.commands ?? []);
  return { features, commands };
}
