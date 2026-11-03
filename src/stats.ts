/** Small seeded PRNG, so simulations and fixtures repeat exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller. */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Standard normal CDF (Abramowitz and Stegun 26.2.17). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? 1 - tail : tail;
}

/** Standard normal quantile (Acklam's rational approximation). */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const horner = (k: number[], x: number) => k.reduce((acc, v) => acc * x + v, 0);
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return horner(c, q) / (horner(d, q) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -horner(c, q) / (horner(d, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (horner(a, r) * q) / (horner(b, r) * r + 1);
}

/**
 * A weighted empirical distribution of log durations. Quantiles happen in log
 * space because agent durations are heavy-tailed and roughly lognormal.
 */
export interface Dist {
  logMs: number[];
  /** Plotting position of each sample in (0, 1). */
  position: number[];
  /** Multiplies distance from the median. Above 1 when the sample is small. */
  widen: number;
  /** Minimum log-space sigma, so one or two samples still give a real range. */
  floorSigma: number;
  /** Log-space shift learned from recorded actuals. */
  shift: number;
  /** Share of each quantile taken from a lognormal fit instead of the raw samples. */
  smooth: number;
  mean: number;
  sigma: number;
}

export function makeDist(
  samples: { ms: number; weight: number }[],
  opts: { widen?: number; floorSigma?: number; shift?: number; smooth?: number } = {},
): Dist {
  const sorted = samples
    .filter((s) => s.weight > 0 && s.ms > 0)
    .map((s) => ({ log: Math.log(s.ms), weight: s.weight }))
    .sort((a, b) => a.log - b.log);
  if (sorted.length === 0) throw new Error('cannot build a distribution from no samples');
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  const position: number[] = [];
  let seen = 0;
  for (const s of sorted) {
    position.push((seen + s.weight / 2) / total);
    seen += s.weight;
  }
  const mean = sorted.reduce((sum, s) => sum + s.weight * s.log, 0) / total;
  const variance = sorted.reduce((sum, s) => sum + s.weight * (s.log - mean) ** 2, 0) / total;
  return {
    logMs: sorted.map((s) => s.log),
    position,
    widen: opts.widen ?? 1,
    floorSigma: opts.floorSigma ?? 0,
    shift: opts.shift ?? 0,
    smooth: opts.smooth ?? 0,
    mean,
    sigma: Math.sqrt(variance),
  };
}

/**
 * A handful of samples leaves steps in the empirical curve, so P80 and P95 can
 * land on the same outlier. Blending in a lognormal fit irons that out.
 */
function rawLogQuantile(dist: Dist, p: number): number {
  const empirical = empiricalLogQuantile(dist, p);
  if (dist.smooth === 0) return empirical;
  return (1 - dist.smooth) * empirical + dist.smooth * (dist.mean + normalInv(p) * dist.sigma);
}

function empiricalLogQuantile(dist: Dist, p: number): number {
  const { logMs, position } = dist;
  const n = logMs.length;
  if (p <= position[0]!) return logMs[0]!;
  if (p >= position[n - 1]!) return logMs[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (position[mid]! <= p) lo = mid;
    else hi = mid;
  }
  const f = (p - position[lo]!) / (position[hi]! - position[lo]!);
  return logMs[lo]! + f * (logMs[hi]! - logMs[lo]!);
}

export function quantile(dist: Dist, p: number): number {
  const centre = rawLogQuantile(dist, 0.5);
  let offset = (rawLogQuantile(dist, p) - centre) * dist.widen;
  if (dist.floorSigma > 0) {
    const floor = normalInv(p) * dist.floorSigma;
    if (Math.abs(offset) < Math.abs(floor)) offset = floor;
  }
  return Math.exp(centre + offset + dist.shift);
}

/** Linear-interpolated quantile of plain numbers. */
export function plainQuantile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (at - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Effective sample size of a set of weights (Kish). */
export function effectiveN(weights: number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  const squares = weights.reduce((a, b) => a + b * b, 0);
  return squares === 0 ? 0 : (sum * sum) / squares;
}

/** Wilson score interval for an observed proportion. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const mid = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (mid - half) / denom), Math.min(1, (mid + half) / denom)];
}
