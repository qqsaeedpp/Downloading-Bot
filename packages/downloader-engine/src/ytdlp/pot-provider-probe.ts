/**
 * Is the configured proof-of-origin token provider actually answering?
 *
 * The failure this exists to prevent: an operator sets YOUTUBE_POT_PROVIDER_URL,
 * restarts, still sees "sign in to confirm you're not a bot", and has no way to
 * tell whether the provider is unreachable or simply was not enough. Those need
 * opposite responses — fix the deployment, or stop trying this approach — and
 * guessing between them costs hours.
 *
 * Deliberately not fatal. A provider is an optimisation for one platform; a bot
 * that refused to start without one would take the other four down with it.
 */

/** The shape of `fetch` this probe needs. Injectable so tests spawn nothing. */
export type FetchLike = (
  input: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export type PotProviderStatus =
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'reachable' }
  | { readonly kind: 'unhealthy'; readonly status: number }
  | { readonly kind: 'unreachable'; readonly reason: string };

const PROBE_TIMEOUT_MS = 5_000;

export async function probePotProvider(
  baseUrl: string | undefined,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PotProviderStatus> {
  if (baseUrl === undefined || baseUrl.trim() === '') return { kind: 'not-configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    // `/ping` is the provider's own liveness endpoint. Trailing slashes are
    // stripped because `http://host:4416/` + `/ping` is a 404, and a 404 here
    // would be reported as "unhealthy" when the service is in fact fine.
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/ping`, {
      signal: controller.signal,
    });
    return response.ok ? { kind: 'reachable' } : { kind: 'unhealthy', status: response.status };
  } catch (error: unknown) {
    // The URL is operator-supplied and may carry credentials in some setups, so
    // only the error's own text is reported — never the URL it was aimed at.
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'unreachable', reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one-line summary for the startup log, and the remedy when there is one.
 *
 * Returns `undefined` when there is nothing worth saying — no provider was
 * configured, or the configured one answered.
 */
export function describePotProviderProblem(status: PotProviderStatus): string | undefined {
  switch (status.kind) {
    case 'not-configured':
    case 'reachable':
      return undefined;
    case 'unhealthy':
      return (
        `the PO token provider answered HTTP ${String(status.status)}. YouTube extraction will ` +
        'behave as if no provider were configured. Check the container logs.'
      );
    case 'unreachable':
      return (
        `the PO token provider could not be reached (${status.reason}). YouTube extraction will ` +
        'behave as if no provider were configured. Check that the service is running and that ' +
        'YOUTUBE_POT_PROVIDER_URL uses the compose service name, not localhost.'
      );
  }
}
