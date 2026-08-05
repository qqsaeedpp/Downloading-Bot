import { supportedPlatformsFa } from '@tgtools/feature-downloader';
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
  // The platform list comes from the downloader's own label table, so the
  // welcome screen cannot disagree with what the bot actually accepts.
  const supportedPlatforms = supportedPlatformsFa();

  const features: BotFeature[] = [
    createStartFeature({ supportedPlatforms }),
    createHelpFeature({
      maxUploadMegabytes: Math.floor(bytesToMegabytes(container.config.limits.maxUploadBytes)),
      supportedPlatforms,
    }),
    // Before the downloader: its link handler is a catch-all on text, and a
    // typed QR payload would otherwise be read as a URL to download.
    ...(container.tools === undefined ? [] : [container.tools]),
    container.downloader.botFeature,
  ];

  for (const feature of features) {
    container.bot.use(feature.composer);
    container.logger.debug('feature registered', { feature: feature.name });
  }

  const commands = features.flatMap((feature) => feature.commands ?? []);
  return { features, commands };
}
