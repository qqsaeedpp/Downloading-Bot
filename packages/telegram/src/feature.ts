import type { Composer } from 'grammy';
import type { AppContext } from './context.js';

/**
 * The single contract a feature exposes to the bot process.
 *
 * The composition root only ever sees this: it never reaches into a feature's
 * handlers, use cases or repositories. Adding a feature is therefore "build one
 * of these and put it in the list" — which is exactly the property that has to
 * hold if the second, third and tenth tool are going to land without disturbing
 * the first.
 */
export interface BotFeature {
  readonly name: string;
  readonly composer: Composer<AppContext>;
  /** Advertised via `setMyCommands`, so `/help` and the menu stay in step. */
  readonly commands?: readonly FeatureCommand[];
}

export interface FeatureCommand {
  readonly command: string;
  readonly description: string;
}
