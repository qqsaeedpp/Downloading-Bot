/**
 * A success-or-failure value for the paths where failure is an ordinary,
 * expected outcome — a link that isn't a link, a quality that no longer exists.
 * Throwing is reserved for the genuinely exceptional, so the type system can
 * force a caller to look at the boring failures instead of hoping a `catch`
 * somewhere upstream deals with them.
 */
export type Result<TValue, TError> =
  { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function err<TError>(error: TError): Result<never, TError> {
  return { ok: false, error };
}

export function isOk<TValue, TError>(
  result: Result<TValue, TError>,
): result is { readonly ok: true; readonly value: TValue } {
  return result.ok;
}

export function isErr<TValue, TError>(
  result: Result<TValue, TError>,
): result is { readonly ok: false; readonly error: TError } {
  return !result.ok;
}

export function mapResult<TValue, TNext, TError>(
  result: Result<TValue, TError>,
  map: (value: TValue) => TNext,
): Result<TNext, TError> {
  return result.ok ? ok(map(result.value)) : result;
}

/** Unwrap or throw. Only for call sites that have already proved the success case. */
export function unwrap<TValue, TError>(result: Result<TValue, TError>): TValue {
  if (result.ok) return result.value;
  throw new Error(`unwrap() on a failed Result: ${String(result.error)}`);
}
