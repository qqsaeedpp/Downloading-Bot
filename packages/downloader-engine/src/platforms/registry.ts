import { ALL_MEDIA_PLATFORMS } from '@tgtools/shared';
import type { MediaPlatform } from '@tgtools/shared';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import { instagramPlatform } from './instagram.js';
import { pinterestPlatform } from './pinterest.js';
import type { PlatformDefinition } from './platform-definition.js';
import { matchesAnyPattern } from './platform-definition.js';
import { tiktokPlatform } from './tiktok.js';
import { xPlatform } from './x.js';
import { youtubePlatform } from './youtube.js';

export const DEFAULT_PLATFORM_DEFINITIONS: readonly PlatformDefinition[] = [
  instagramPlatform,
  tiktokPlatform,
  pinterestPlatform,
  xPlatform,
  youtubePlatform,
];

export interface PlatformRegistry {
  readonly definitions: readonly PlatformDefinition[];
  /** The definition that claims this URL, if any. */
  detect(url: URL): PlatformDefinition | undefined;
  /** Host is ours even if the path is not a media path — used by the SSRF guard. */
  isKnownHost(hostname: string): boolean;
  get(platform: MediaPlatform): PlatformDefinition;
  isShortLink(url: URL): boolean;
}

/**
 * Adding a platform is: write a definition, put it in this list. Nothing else
 * in the engine, the feature or the bot needs to change.
 */
export function createPlatformRegistry(
  definitions: readonly PlatformDefinition[] = DEFAULT_PLATFORM_DEFINITIONS,
): PlatformRegistry {
  assertCompleteCoverage(definitions);
  const byPlatform = new Map(definitions.map((definition) => [definition.platform, definition]));

  return {
    definitions,

    detect(url: URL): PlatformDefinition | undefined {
      return definitions.find((definition) => definition.supports(url));
    },

    isKnownHost(hostname: string): boolean {
      return definitions.some((definition) => matchesAnyPattern(hostname, definition.hostPatterns));
    },

    get(platform: MediaPlatform): PlatformDefinition {
      const definition = byPlatform.get(platform);
      if (definition === undefined) {
        throw new EngineError(
          EngineFailureCode.UnsupportedPlatform,
          `No platform definition registered for "${platform}"`,
        );
      }
      return definition;
    },

    isShortLink(url: URL): boolean {
      const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
      return definitions.some((definition) =>
        definition.createPolicy().shortLinkHosts.includes(hostname),
      );
    },
  };
}

/**
 * A platform in the vocabulary with no definition behind it is a wiring bug
 * that would otherwise only surface when a user pasted that kind of link.
 */
function assertCompleteCoverage(definitions: readonly PlatformDefinition[]): void {
  const covered = new Set(definitions.map((definition) => definition.platform));
  const missing = ALL_MEDIA_PLATFORMS.filter((platform) => !covered.has(platform));
  if (missing.length > 0) {
    throw new EngineError(
      EngineFailureCode.Internal,
      `Platform registry is missing definitions for: ${missing.join(', ')}`,
    );
  }
}
