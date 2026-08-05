/**
 * Finding a quality setting that hits a byte target.
 *
 * Separated from Sharp and kept pure because the interesting failures here are
 * arithmetic, not imaging: a loop that never terminates, a scale factor that
 * collapses a photo to nothing in one step, an "improvement" that is actually
 * worse than the previous attempt. All of those can be tested against a fake
 * encoder in microseconds; none of them need a real JPEG.
 */

export interface TargetSearchPolicy {
  readonly minQuality: number;
  readonly maxQuality: number;
  /**
   * Ceiling on encodes per resize stage.
   *
   * Binary search over ~55 quality points converges in about six steps, and
   * each step is a full encode — so this is a wall-clock budget, not a
   * precision setting.
   */
  readonly maxQualityAttempts: number;
  /** How many times the image may be shrunk when quality alone is not enough. */
  readonly maxResizeStages: number;
}

export const DEFAULT_TARGET_SEARCH_POLICY: TargetSearchPolicy = {
  minQuality: 35,
  maxQuality: 90,
  maxQualityAttempts: 6,
  maxResizeStages: 2,
};

export interface TargetSearchAttempt {
  readonly quality: number;
  readonly scale: number;
  readonly sizeBytes: number;
}

export interface TargetSearchOutcome {
  readonly quality: number;
  /** 1 means the original dimensions. */
  readonly scale: number;
  readonly sizeBytes: number;
  readonly met: boolean;
  readonly attempts: readonly TargetSearchAttempt[];
}

/** Encodes at a quality and scale, returning the resulting byte count. */
export type EncodeProbe = (quality: number, scale: number) => Promise<number>;

/**
 * How much to shrink when quality alone cannot reach the target.
 *
 * File size scales roughly with pixel count, so the square root of the size
 * ratio is the first-order estimate of the linear scale needed. It is only an
 * estimate — compression is not linear in area — so the result is clamped:
 * below 0.65 a single step throws away far more detail than the target
 * requires, and above 0.95 the step is too small to be worth another encode.
 */
export function estimateScale(currentBytes: number, targetBytes: number): number {
  if (currentBytes <= 0 || targetBytes <= 0) return 0.95;
  const ratio = Math.sqrt(targetBytes / currentBytes);
  return Math.min(0.95, Math.max(0.65, ratio));
}

/**
 * Search for the highest quality whose output fits under `targetBytes`.
 *
 * Bounded on both axes — quality attempts and resize stages — so the worst case
 * is a fixed number of encodes rather than a loop that runs until it happens to
 * succeed. When the target cannot be met, the best result SEEN is returned with
 * `met: false`, because the closest attempt is more useful to the user than a
 * failure, and far more useful than the last attempt, which is not necessarily
 * the smallest.
 */
export async function searchForTargetSize(
  targetBytes: number,
  encode: EncodeProbe,
  policy: TargetSearchPolicy = DEFAULT_TARGET_SEARCH_POLICY,
): Promise<TargetSearchOutcome> {
  const attempts: TargetSearchAttempt[] = [];
  let scale = 1;

  // Tracks the best FITTING result across every stage. Reset would lose a
  // perfectly good answer found before a resize that turned out unnecessary.
  let best: TargetSearchAttempt | undefined;
  let smallest: TargetSearchAttempt | undefined;

  for (let stage = 0; stage <= policy.maxResizeStages; stage += 1) {
    let low = policy.minQuality;
    let high = policy.maxQuality;

    for (let attempt = 0; attempt < policy.maxQualityAttempts && low <= high; attempt += 1) {
      const quality = Math.floor((low + high) / 2);
      const sizeBytes = await encode(quality, scale);
      const record: TargetSearchAttempt = { quality, scale, sizeBytes };
      attempts.push(record);

      if (smallest === undefined || sizeBytes < smallest.sizeBytes) smallest = record;

      if (sizeBytes <= targetBytes) {
        // Fits. Keep it only if it beats what we already have — a higher
        // quality at the same scale, or any fit at a larger scale.
        if (best === undefined || quality > best.quality || scale > best.scale) best = record;
        // Try to spend the remaining headroom on quality.
        low = quality + 1;
      } else {
        high = quality - 1;
      }
    }

    if (best !== undefined) break;

    // Nothing fitted even at the lowest quality, so the dimensions are the
    // problem. Estimate from the smallest result seen at this scale.
    if (stage === policy.maxResizeStages) break;
    const reference = smallest;
    if (reference === undefined) break;
    scale = Number((scale * estimateScale(reference.sizeBytes, targetBytes)).toFixed(4));
  }

  const chosen = best ?? smallest;
  if (chosen === undefined) {
    // Only reachable if the policy permits zero attempts, which the config
    // schema forbids. Reported honestly rather than pretending to a result.
    return {
      quality: policy.minQuality,
      scale: 1,
      sizeBytes: 0,
      met: false,
      attempts,
    };
  }

  return {
    quality: chosen.quality,
    scale: chosen.scale,
    sizeBytes: chosen.sizeBytes,
    met: chosen.sizeBytes <= targetBytes,
    attempts,
  };
}
