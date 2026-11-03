import { describe, expect, it } from 'vitest';
import { backtest, LEVELS, score, type Forecast } from '../src/backtest.js';
import { gaussian, mulberry32 } from '../src/stats.js';
import { BASE, session } from './helpers.js';

const at = (level: number) => LEVELS.indexOf(level as (typeof LEVELS)[number]);

describe('coverage maths', () => {
  /** Quantiles fixed at 10, 20, 30, 40, 50, 60 so hits can be counted by hand. */
  const q = [10, 20, 30, 40, 50, 60];
  const f = (actualMs: number): Forecast => ({ actualMs, quantiles: q });

  it('counts the share of actuals at or under each quantile', () => {
    const s = score([f(5), f(15), f(25), f(35), f(45), f(55), f(65), f(40), f(30), f(10)]);
    const observed = s.calibration.map((c) => c.observed);
    // Actuals sorted: 5 10 15 25 30 35 40 45 55 65.
    expect(observed).toEqual([0.2, 0.3, 0.5, 0.7, 0.8, 0.9]);
    expect(s.coverageP80).toBe(0.7);
    expect(s.evaluated).toBe(10);
  });

  it('counts an actual exactly on the quantile as covered', () => {
    expect(score([f(40)]).coverageP80).toBe(1);
  });

  it('computes median absolute percentage error of the P50', () => {
    // P50 is 30. Errors: 0%, 50%, 200%.
    expect(score([f(30), f(60), f(10)]).mdape).toBeCloseTo(0.5);
  });

  it('computes the spread from P95 over P50', () => {
    expect(score([f(30)]).medianSpread).toBeCloseTo(2);
  });

  it('gives each level a confidence interval around what was observed', () => {
    const s = score(Array.from({ length: 100 }, (_, i) => f(i)));
    for (const c of s.calibration) {
      expect(c.ci[0]).toBeLessThanOrEqual(c.observed);
      expect(c.ci[1]).toBeGreaterThanOrEqual(c.observed);
    }
  });

  it('is NaN, not a false zero, with no forecasts', () => {
    expect(score([]).coverageP80).toBeNaN();
  });
});

/** Stationary lognormal history. Empirical quantiles should come out calibrated. */
function stationary(count: number, seed = 11) {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, (_, i) =>
    session(20 * Math.exp(0.7 * gaussian(rand)), { startedAt: BASE + i * 24 * 3_600_000, repo: 'api', text: 'same kind of task' }),
  );
}

describe('backtest', () => {
  it('comes out calibrated on a stationary history', () => {
    const r = backtest(stationary(500));
    expect(r.method).toBe('rolling');
    expect(r.evaluated).toBeGreaterThan(400);
    expect(r.calibration[at(0.5)]!.observed).toBeGreaterThan(0.42);
    expect(r.calibration[at(0.5)]!.observed).toBeLessThan(0.58);
    expect(r.coverageP80).toBeGreaterThan(0.74);
    expect(r.coverageP80).toBeLessThan(0.88);
    expect(r.calibration[at(0.95)]!.observed).toBeGreaterThan(0.9);
    expect(r.mdape).toBeGreaterThan(0);
  });

  it('rolling origin cannot see the future', () => {
    // Durations jump tenfold halfway. A forecast that peeked would cover the jump.
    const shifted = [
      ...Array.from({ length: 100 }, (_, i) => session(10 + (i % 10) * 0.1, { startedAt: BASE + i * 3_600_000 })),
      ...Array.from({ length: 10 }, (_, i) => session(100 + i, { startedAt: BASE + (100 + i) * 3_600_000 })),
    ];
    const r = backtest(shifted, { minTrain: 100, method: 'rolling' });
    expect(r.evaluated).toBe(10);
    expect(r.coverageP80).toBeLessThan(0.3);
  });

  it('leave-one-out excludes the session being forecast', () => {
    const twins = [session(10), session(1000)];
    // Each can only see the other, so neither P50 can match its own duration.
    const r = backtest(twins, { method: 'loo' });
    expect(r.evaluated).toBe(2);
    expect(r.mdape).toBeGreaterThan(0.9);
  });

  it('never uses sessions that overlap the forecast start', () => {
    const overlapping = [
      ...Array.from({ length: 40 }, (_, i) => session(5, { startedAt: BASE + i * 3_600_000 })),
      session(100_000, { startedAt: BASE, activeMs: 11 * 3_600_000 }),
    ];
    expect(() => backtest(overlapping, { minTrain: 5 })).not.toThrow();
  });

  it('thins large histories evenly to the limit', () => {
    expect(backtest(stationary(300), { limit: 50 }).evaluated).toBe(50);
  });

  it('beats a plain median when durations follow what the brief says', () => {
    const rand = mulberry32(3);
    const sessions = Array.from({ length: 400 }, (_, i) => {
      const big = i % 2 === 0;
      return session((big ? 200 : 10) * Math.exp(0.2 * gaussian(rand)), {
        startedAt: BASE + i * 3_600_000,
        text: big ? 'migrate database cluster' : 'tweak button colour',
      });
    });
    const r = backtest(sessions);
    expect(r.mdape).toBeLessThan(r.baseline.mdape - 0.2);
    expect(r.verdict.join(' ')).toMatch(/beats a plain median/);
  });

  it('breaks results down by class and confidence', () => {
    const r = backtest(stationary(120));
    expect(r.byClass[0]!.group).toBe('repo');
    expect(r.byClass[0]!.n).toBe(r.evaluated);
    expect(r.byConfidence.reduce((sum, g) => sum + g.n, 0)).toBe(r.evaluated);
  });

  it('declines to claim anything from too few forecasts', () => {
    const r = backtest(stationary(40));
    expect(r.evaluated).toBeLessThan(30);
    expect(r.verdict.join(' ')).toMatch(/too few/);
  });

  it('reports optimism when the P80 undercovers', () => {
    const rand = mulberry32(4);
    // Each session runs longer than everything before it, so P80 keeps missing.
    const drift = Array.from({ length: 200 }, (_, i) =>
      session(5 * 1.03 ** i * Math.exp(0.05 * gaussian(rand)), { startedAt: BASE + i * 24 * 3_600_000 }),
    );
    expect(backtest(drift).verdict.join(' ')).toMatch(/optimistic/);
  });

  it('handles an empty history', () => {
    const r = backtest([]);
    expect(r.evaluated).toBe(0);
    expect(r.usable).toBe(0);
    expect(r.verdict.join(' ')).toMatch(/too few/);
  });

  it('scores only usable sessions', () => {
    const failed = Array.from({ length: 50 }, () => session(10, { outcome: 'failed' }));
    expect(backtest(failed).usable).toBe(0);
  });
});
