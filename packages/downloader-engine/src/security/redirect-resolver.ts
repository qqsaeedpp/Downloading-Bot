import { lookup } from 'node:dns/promises';
import type { Logger } from '@tgtools/shared';
import { createAbortScope, describeError, redactUrl } from '@tgtools/shared';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import { inspectIpAddress } from './ip-rules.js';
import type { SafeMediaUrl, UrlGuard } from './url-guard.js';

const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 8_000;

export interface RedirectResolverOptions {
  readonly guard: UrlGuard;
  readonly logger: Logger;
  readonly maxHops?: number;
  readonly hopTimeoutMs?: number;
  /** Injected in tests so the resolver can be exercised without a network. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Follows `vm.tiktok.com`, `pin.it` and `t.co` links to the post they point at.
 *
 * Redirects are followed one hop at a time with `redirect: 'manual'` rather than
 * letting `fetch` chase them: the whole point is to inspect every intermediate
 * `Location` before deciding whether to make the next request. Every hop is
 * re-validated by the same guard as the original URL, so the chain can never
 * walk off the list of supported platforms and into someone's internal network.
 */
export class RedirectResolver {
  readonly #guard: UrlGuard;
  readonly #logger: Logger;
  readonly #maxHops: number;
  readonly #hopTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: RedirectResolverOptions) {
    this.#guard = options.guard;
    this.#logger = options.logger;
    this.#maxHops = options.maxHops ?? MAX_HOPS;
    this.#hopTimeoutMs = options.hopTimeoutMs ?? HOP_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async resolve(start: SafeMediaUrl, signal?: AbortSignal): Promise<SafeMediaUrl> {
    if (!start.isShortLink) return start;

    let current = start;
    for (let hop = 0; hop < this.#maxHops; hop += 1) {
      const location = await this.#fetchLocation(current, signal);
      if (location === undefined) {
        // The short host answered with a body instead of a redirect. Some
        // shorteners do this for expired links; either way there is nothing
        // further to follow.
        return current;
      }

      const next = this.#guard.parseRedirectTarget(location, current.url);
      this.#logger.debug('resolved short link hop', {
        hop,
        from: redactUrl(current.normalizedUrl),
        to: redactUrl(next.normalizedUrl),
      });

      if (!next.isShortLink) return next;
      current = next;
    }

    throw new EngineError(
      EngineFailureCode.InvalidUrl,
      `Short link did not settle within ${this.#maxHops} redirects`,
    );
  }

  async #fetchLocation(target: SafeMediaUrl, signal?: AbortSignal): Promise<string | undefined> {
    await assertResolvesToPublicAddress(target.url.hostname);

    const scope = createAbortScope({
      parent: signal,
      timeoutMs: this.#hopTimeoutMs,
      label: 'redirect',
    });
    try {
      const response = await this.#fetch(target.url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: scope.signal,
        headers: {
          // Shorteners routinely serve a redirect to browsers and an
          // interstitial to anything that looks automated.
          'user-agent': 'Mozilla/5.0 (compatible; telegram-tools-bot/1.0)',
          accept: '*/*',
        },
      });
      if (response.status < 300 || response.status >= 400) return undefined;
      return response.headers.get('location') ?? undefined;
    } catch (error: unknown) {
      throw new EngineError(
        EngineFailureCode.DownloadFailed,
        `Could not resolve short link: ${describeError(error)}`,
        { cause: error, retryable: true },
      );
    } finally {
      scope.dispose();
    }
  }
}

/**
 * Defence in depth against DNS rebinding: even a host on our allow-list must not
 * be contacted if it currently resolves into private space.
 *
 * This narrows the window rather than closing it — the address could change
 * between this check and the connection — but the hosts involved are a handful
 * of well-known shorteners, so the residual risk is small and the check is cheap.
 */
export async function assertResolvesToPublicAddress(hostname: string): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error: unknown) {
    throw new EngineError(EngineFailureCode.DownloadFailed, `Host "${hostname}" did not resolve`, {
      cause: error,
      retryable: true,
    });
  }

  for (const { address } of addresses) {
    const verdict = inspectIpAddress(address);
    if (!verdict.allowed) {
      throw new EngineError(
        EngineFailureCode.InvalidUrl,
        `Host "${hostname}" resolves to a non-public address (${verdict.reason ?? 'blocked range'})`,
      );
    }
  }
}
