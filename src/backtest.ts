import { durationMs, Estimator, isUsable, type EstimatorOptions } from './estimator.js';
import { plainQuantile, quantile, wilson } from './stats.js';
import type { Confidence, Query, Session } from './types.js';

export const LEVELS = [0.1, 0.25, 0.5, 0.8, 0.9, 0.95] as const;

export interface BacktestOptions extends EstimatorOptions {
  method?: 'rolling' | 'loo';
  /** Sessions set aside before the first rolling-origin forecast. */
  minTrain?: number;
  /** Most forecasts to run. Larger histories are thinned evenly. */
  limit?: number;
}

/** One forecast: its quantiles at LEVELS, and what actually happened. */
export interface Forecast {
  actualMs: number;
  quantiles: number[];
  confidence?: Confidence;
  classLevel?: string;
}

export interface CoverageRow {
  level: number;
  observed: number;
  ci: [number, number];
}

export interface GroupStats {
  group: string;
  n: number;
  coverageP80: number;
  mdape: number;
}

export interface Scorecard {
  evaluated: number;
  calibration: CoverageRow[];
  coverageP80: number;
  /** Median absolute percentage error of the P50, as a fraction. */
  mdape: number;
  /** Median P95/P50 ratio. Coverage is cheap if ranges are huge, so report this too. */
  medianSpread: number;
}

export interface BacktestReport extends Scorecard {
  method: 'rolling' | 'loo';
  usable: number;
  /** The same scoring for a forecast that ignores similarity: all past sessions, equally weighted. */
  baseline: Scorecard;
  byClass: GroupStats[];
  byConfidence: GroupStats[];
  verdict: string[];
}

/** Scores forecasts. Coverage is one-sided: did the actual land at or under the quantile? */
export function score(forecasts: Forecast[]): Scorecard {
  const n = forecasts.length;
  const calibration = LEVELS.map((level, k) => {
    const hits = forecasts.filter((f) => f.actualMs <= f.quantiles[k]!).length;
    return { level, observed: n ? hits / n : NaN, ci: wilson(hits, n) };
  });
  const p50 = LEVELS.indexOf(0.5);
  const p95 = LEVELS.indexOf(0.95);
  return {
    evaluated: n,
    calibration,
    coverageP80: calibration[LEVELS.indexOf(0.8)]!.observed,
    mdape: plainQuantile(
      forecasts.map((f) => Math.abs(f.quantiles[p50]! - f.actualMs) / f.actualMs),
      0.5,
    ),
    medianSpread: plainQuantile(
      forecasts.map((f) => f.quantiles[p95]! / f.quantiles[p50]!),
      0.5,
    ),
  };
}

function toQuery(s: Session): Query {
  return {
    brief: s.text ?? s.title ?? '',
    ...(s.repo ? { repo: s.repo } : {}),
    ...(s.model ? { model: s.model } : {}),
    scopeCount: s.scopeCount,
  };
}

function groupStats(forecasts: Forecast[], key: (f: Forecast) => string | undefined): GroupStats[] {
  const groups = new Map<string, Forecast[]>();
  for (const f of forecasts) {
    const k = key(f);
    if (k === undefined) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  return [...groups]
    .map(([group, list]) => {
      const s = score(list);
      return { group, n: list.length, coverageP80: s.coverageP80, mdape: s.mdape };
    })
    .sort((a, b) => b.n - a.n);
}

function thin<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor((i * items.length) / limit)]!);
  return out;
}

/**
 * Replays history. `rolling` only lets a forecast see sessions that had ended
 * before it started, so it matches real use and is the default. `loo` holds out
 * one session at a time and uses all the others, including later ones.
 */
export function backtest(sessions: Iterable<Session>, opts: BacktestOptions = {}): BacktestReport {
  const method = opts.method ?? 'rolling';
  const capMs = opts.capMs;
  const usable = [...sessions].filter((s) => isUsable(s, capMs)).sort((a, b) => a.startedAt - b.startedAt);
  const limit = opts.limit ?? 2000;
  const forecasts: Forecast[] = [];
  const baselines: Forecast[] = [];

  const run = (estimator: Estimator, target: Session, train: number[], excludeId?: string) => {
    const estimate = estimator.estimate(toQuery(target), excludeId);
    const actualMs = durationMs(target, capMs);
    forecasts.push({
      actualMs,
      quantiles: LEVELS.map((p) => quantile(estimate.dist, p)),
      confidence: estimate.confidence,
      classLevel: estimate.class.level,
    });
    baselines.push({ actualMs, quantiles: LEVELS.map((p) => plainQuantile(train, p)) });
  };

  if (method === 'loo') {
    const estimator = new Estimator(usable, opts);
    const all = usable.map((s) => durationMs(s, capMs));
    for (const target of thin(usable, limit)) {
      if (usable.length < 2) break;
      run(estimator, target, all, target.id);
    }
  } else {
    const minTrain = opts.minTrain ?? 30;
    const targets = thin(usable.slice(minTrain), limit);
    // Refitting per block keeps the replay cheap. Nothing inside a block is
    // visible to its neighbours, which errs slightly against us.
    const blocks = 40;
    const size = Math.max(1, Math.ceil(targets.length / blocks));
    for (let b = 0; b < targets.length; b += size) {
      const block = targets.slice(b, b + size);
      const origin = block[0]!.startedAt;
      const train = usable.filter((s) => s.endedAt <= origin);
      if (train.length === 0) continue;
      const estimator = new Estimator(train, opts);
      const durations = train.map((s) => durationMs(s, capMs));
      for (const target of block) run(estimator, target, durations);
    }
  }

  const overall = score(forecasts);
  const baseline = score(baselines);
  return {
    method,
    usable: usable.length,
    ...overall,
    baseline,
    byClass: groupStats(forecasts, (f) => f.classLevel),
    byConfidence: groupStats(forecasts, (f) => f.confidence),
    verdict: verdict(overall, baseline),
  };
}

function verdict(result: Scorecard, baseline: Scorecard): string[] {
  if (result.evaluated < 30) {
    return [`Only ${result.evaluated} forecasts could be scored. That is too few to claim calibration either way.`];
  }
  const lines: string[] = [];
  const p80 = result.calibration.find((c) => c.level === 0.8)!;
  const pct = Math.round(p80.observed * 100);
  if (p80.ci[0] <= 0.8 && p80.ci[1] >= 0.8) lines.push(`P80 is calibrated: ${pct}% landed under it.`);
  else if (p80.observed < 0.8) lines.push(`P80 runs optimistic: only ${pct}% landed under it. Treat it as a lower bound.`);
  else lines.push(`P80 runs cautious: ${pct}% landed under it, so ranges are wider than they need to be.`);
  const gain = baseline.mdape - result.mdape;
  if (gain > 0.01) {
    lines.push(`Similarity beats a plain median of all sessions by ${Math.round(gain * 100)} points of error.`);
  } else {
    lines.push('Similarity does not beat a plain median of all sessions on this history.');
  }
  return lines;
}
