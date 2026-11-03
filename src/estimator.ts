import { effectiveN, makeDist, quantile, type Dist } from './stats.js';
import { TextIndex } from './text.js';
import type { ClassLevel, Comparable, Confidence, Query, Range, Session } from './types.js';

export const HOUR = 3_600_000;

export interface EstimatorOptions {
  /** Smallest class worth forecasting from before falling back to a broader one. */
  minClass?: number;
  /** How many of the most similar sessions make up the reference class. */
  topK?: number;
  /** Longest believable duration for one session. */
  capMs?: number;
  /** Learned from recorded actuals, see store.ts. */
  calibration?: Calibration;
}

export interface Calibration {
  n: number;
  /** Log-space shift of the whole distribution. */
  shift: number;
  /** Extra multiplier on spread, never below 1. */
  spread: number;
}

export interface Estimate extends Range {
  n: number;
  effectiveN: number;
  confidence: Confidence;
  class: { level: ClassLevel; label: string };
  comparables: Comparable[];
  caveats: string[];
  /** The same three numbers before any recorded-actuals adjustment. */
  raw: Range;
  /** The full distribution behind the three numbers, for plan simulation. */
  dist: Dist;
}

export class NoHistoryError extends Error {
  constructor(message = 'No usable finished sessions in this source, so there is nothing to forecast from.') {
    super(message);
    this.name = 'NoHistoryError';
  }
}

const SIGNAL_WEIGHT = { high: 1, medium: 0.7, low: 0.25 } as const;
const FINISHED = new Set(['merged', 'completed', 'unknown']);
const MIN_DURATION_MS = 30_000;

/** The duration we forecast: active time when known, else the raw span, capped. */
export function durationMs(s: Session, capMs = 12 * HOUR): number {
  return Math.min(s.activeMs ?? s.endedAt - s.startedAt, capMs);
}

/**
 * Finished work with a believable duration. A span with no activity data longer
 * than the cap is almost always a session left open, so it is dropped, since
 * clamping it would invent a cluster of sessions at exactly the cap.
 */
export function isUsable(s: Session, capMs = 12 * HOUR): boolean {
  if (!FINISHED.has(s.outcome)) return false;
  if (s.activeMs === undefined && s.endedAt - s.startedAt > capMs) return false;
  return durationMs(s, capMs) >= MIN_DURATION_MS;
}

function matchesModel(session: Session, model: string): boolean {
  return session.model?.toLowerCase().includes(model.toLowerCase()) ?? false;
}

function matchesRepo(session: Session, repo: string): boolean {
  return session.repo?.toLowerCase() === repo.toLowerCase();
}

function ratioSimilarity(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0.5;
  return Math.min(a, b) / Math.max(a, b);
}

/** A small sample understates its own spread, so stretch it, less as the sample grows. */
export function widenFactor(nEff: number): number {
  return 1 + 0.7 / Math.sqrt(Math.max(nEff, 1));
}

export class Estimator {
  readonly pool: Session[];
  private durations: number[];
  private index: TextIndex;
  private opts: Required<Omit<EstimatorOptions, 'calibration'>> & { calibration?: Calibration };

  constructor(sessions: Iterable<Session>, opts: EstimatorOptions = {}) {
    this.opts = { minClass: 8, topK: 60, capMs: 12 * HOUR, ...opts };
    this.pool = [...sessions].filter((s) => isUsable(s, this.opts.capMs));
    this.durations = this.pool.map((s) => durationMs(s, this.opts.capMs));
    this.index = new TextIndex(this.pool.map((s) => s.text ?? s.title ?? ''));
  }

  /** `excludeId` hides one session, which is how leave-one-out works. */
  estimate(query: Query, excludeId?: string): Estimate {
    const { members, level, label, caveats } = this.chooseClass(query, excludeId);
    if (members.length === 0) throw new NoHistoryError();

    const scored = this.score(members, query);
    // With a vague brief many weights tie. Newer work then wins, since tools and models get faster.
    scored.sort((a, b) => b.weight - a.weight || this.pool[b.i]!.startedAt - this.pool[a.i]!.startedAt);
    const used = scored.slice(0, this.opts.topK);
    const weights = used.map((u) => u.weight);
    const nEff = effectiveN(weights);
    const cal = this.opts.calibration;
    const rawDist = makeDist(
      used.map((u) => ({ ms: this.durations[u.i]!, weight: u.weight })),
      { widen: widenFactor(nEff), floorSigma: nEff < 5 ? 0.6 : 0, smooth: 10 / (10 + nEff) },
    );
    const dist = cal ? { ...rawDist, widen: rawDist.widen * cal.spread, shift: cal.shift } : rawDist;
    const range = rangeOf(dist);

    if (nEff < 10) {
      caveats.push(`Only about ${Math.round(nEff)} comparable sessions, so the range was widened.`);
    }
    const lowSignal = used.filter((u) => this.pool[u.i]!.signal === 'low').length;
    if (lowSignal > used.length / 2) {
      caveats.push('Most comparables only have start and end stamps, so idle time may be counted.');
    }
    if (cal) caveats.push(`Adjusted using ${cal.n} recorded actuals.`);

    return {
      ...range,
      n: used.length,
      effectiveN: Math.round(nEff * 10) / 10,
      confidence: confidenceLabel(nEff, level, range),
      class: { level, label },
      comparables: used.slice(0, 5).map((u) => {
        const s = this.pool[u.i]!;
        return {
          id: s.id,
          ...(s.title ? { title: s.title } : {}),
          ...(s.repo ? { repo: s.repo } : {}),
          durationMs: this.durations[u.i]!,
          similarity: Math.round(u.sim * 100) / 100,
        };
      }),
      caveats,
      raw: rangeOf(rawDist),
      dist,
    };
  }

  private chooseClass(query: Query, excludeId?: string) {
    const eligible: number[] = [];
    this.pool.forEach((s, i) => {
      if (s.id !== excludeId) eligible.push(i);
    });
    const { repo, model } = query;
    const levels: { level: ClassLevel; label: string; test: (s: Session) => boolean }[] = [];
    if (repo && model) {
      levels.push({
        level: 'repo+model',
        label: `same repo "${repo}" and model "${model}"`,
        test: (s) => matchesRepo(s, repo) && matchesModel(s, model),
      });
    }
    if (repo) levels.push({ level: 'repo', label: `same repo "${repo}"`, test: (s) => matchesRepo(s, repo) });
    if (model) levels.push({ level: 'model', label: `same model "${model}"`, test: (s) => matchesModel(s, model) });

    const caveats: string[] = [];
    for (const { level, label, test } of levels) {
      const members = eligible.filter((i) => test(this.pool[i]!));
      if (members.length >= this.opts.minClass) return { members, level, label, caveats };
    }
    if (levels.length > 0) {
      caveats.push(`Too few sessions matched ${levels.at(-1)!.label}, so this uses all your sessions.`);
    }
    return { members: eligible, level: 'global' as ClassLevel, label: 'all sessions', caveats };
  }

  private score(members: number[], query: Query) {
    const text = query.brief ?? '';
    const textScores = text ? this.index.scores(text) : new Map<number, number>();
    const tokenRank = query.size ? rankByTokens(members.map((i) => this.pool[i]!.tokens)) : undefined;
    const target = query.size === 'small' ? 1 / 6 : query.size === 'large' ? 5 / 6 : 1 / 2;

    return members.map((i, m) => {
      const s = this.pool[i]!;
      const textSim = textScores.get(i) ?? 0;
      let sizeSim = text ? ratioSimilarity(text.length, s.briefChars) : 0.5;
      if (tokenRank) {
        const rank = tokenRank[m];
        sizeSim = rank === undefined ? 0.5 : 1 - Math.abs(rank - target);
      }
      const scopeSim = ratioSimilarity(query.scopeCount ?? 0, s.scopeCount);
      const sim = 0.6 * textSim + 0.25 * sizeSim + 0.15 * scopeSim;
      // Cubing lets close matches dominate without ever fully excluding the rest.
      const weight = SIGNAL_WEIGHT[s.signal] * (0.1 + sim) ** 3;
      return { i, sim, weight };
    });
  }
}

function rangeOf(dist: Dist): Range {
  return { p50Ms: quantile(dist, 0.5), p80Ms: quantile(dist, 0.8), p95Ms: quantile(dist, 0.95) };
}

/** Each value's rank in 0..1, undefined when the session has no token count. */
function rankByTokens(tokens: (number | undefined)[]): (number | undefined)[] {
  const known = tokens.filter((t): t is number => t !== undefined && t > 0).sort((a, b) => a - b);
  if (known.length === 0) return tokens.map(() => undefined);
  return tokens.map((t) => {
    if (t === undefined || t <= 0) return undefined;
    return known.indexOf(t) / Math.max(known.length - 1, 1);
  });
}

function confidenceLabel(nEff: number, level: ClassLevel, range: Range): Confidence {
  const spread = range.p95Ms / range.p50Ms;
  if (nEff >= 20 && level !== 'global' && spread <= 6) return 'high';
  if (nEff >= 8) return 'medium';
  return 'low';
}
