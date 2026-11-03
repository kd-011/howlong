import { describe, expect, it } from 'vitest';
import { durationMs, Estimator, HOUR, isUsable, NoHistoryError } from '../src/estimator.js';
import { MIN, session } from './helpers.js';

const many = (count: number, minutes: number, over = {}) =>
  Array.from({ length: count }, (_, i) => session(minutes + i * 0.5, over));

describe('durationMs and isUsable', () => {
  it('prefers active time over the raw span', () => {
    expect(durationMs(session(10, { endedAt: Date.now() + 1e9 }))).toBe(10 * MIN);
  });

  it('caps a huge active time', () => {
    expect(durationMs(session(100 * 60))).toBe(12 * HOUR);
  });

  it('drops an idle span with no activity data, since clamping would invent data', () => {
    const left = session(10, { activeMs: undefined, signal: 'low', endedAt: Date.UTC(2027, 0, 1) });
    expect(isUsable(left)).toBe(false);
  });

  it('keeps a believable span with no activity data', () => {
    expect(isUsable(session(10, { activeMs: undefined, signal: 'low' }))).toBe(true);
  });

  it('excludes failed, abandoned and trivial sessions', () => {
    expect(isUsable(session(10, { outcome: 'failed' }))).toBe(false);
    expect(isUsable(session(10, { outcome: 'abandoned' }))).toBe(false);
    expect(isUsable(session(0.1))).toBe(false);
  });
});

describe('reference classes', () => {
  const history = [
    ...many(10, 10, { repo: 'api', model: 'fast' }),
    ...many(10, 40, { repo: 'api', model: 'slow' }),
    ...many(10, 100, { repo: 'web', model: 'fast' }),
    ...many(3, 500, { repo: 'tiny', model: 'rare' }),
  ];
  const estimator = new Estimator(history);

  it('uses repo and model when both have enough history', () => {
    const e = estimator.estimate({ repo: 'api', model: 'fast' });
    expect(e.class.level).toBe('repo+model');
    expect(e.class.label).toContain('api');
    expect(e.p50Ms).toBeLessThan(20 * MIN);
  });

  it('falls back to repo when the pair is too thin', () => {
    const e = estimator.estimate({ repo: 'web', model: 'slow' });
    expect(e.class.level).toBe('repo');
    expect(e.p50Ms).toBeGreaterThan(90 * MIN);
  });

  it('falls back to model when the repo is too thin', () => {
    const e = estimator.estimate({ repo: 'tiny', model: 'fast' });
    expect(e.class.level).toBe('model');
  });

  it('falls back to everything and says so', () => {
    const e = estimator.estimate({ repo: 'tiny', model: 'rare' });
    expect(e.class.level).toBe('global');
    expect(e.caveats.join(' ')).toMatch(/Too few sessions/);
  });

  it('uses everything without complaint when nothing was specified', () => {
    const e = estimator.estimate({ brief: 'whatever' });
    expect(e.class.level).toBe('global');
    expect(e.caveats.join(' ')).not.toMatch(/Too few/);
  });

  it('matches repo case-insensitively and model by part of its name', () => {
    expect(estimator.estimate({ repo: 'API' }).class.level).toBe('repo');
    const partial = new Estimator(many(10, 10, { model: 'vendor/model-opus-5' }));
    expect(partial.estimate({ model: 'opus' }).class.level).toBe('model');
  });
});

describe('similarity', () => {
  const history = [
    ...many(20, 10, { text: 'Fix flaky login test', title: 'Fix flaky login test' }),
    ...many(20, 200, { text: 'Migrate billing database schema', title: 'Migrate billing database schema' }),
  ];
  const estimator = new Estimator(history);

  it('pulls the estimate toward sessions with similar briefs', () => {
    expect(estimator.estimate({ brief: 'Fix flaky login test again' }).p50Ms).toBeLessThan(30 * MIN);
    expect(estimator.estimate({ brief: 'Migrate billing database' }).p50Ms).toBeGreaterThan(120 * MIN);
  });

  it('lists the closest sessions it used', () => {
    const e = estimator.estimate({ brief: 'Fix flaky login test' });
    expect(e.comparables.length).toBeGreaterThan(0);
    expect(e.comparables[0]!.title).toBe('Fix flaky login test');
    expect(e.comparables[0]!.similarity).toBeGreaterThan(0.5);
  });

  it('uses expected size to prefer sessions with matching token counts', () => {
    const sized = Array.from({ length: 60 }, (_, i) => session(5 + i * 5, { tokens: 1000 * (i + 1) }));
    const e = new Estimator(sized);
    expect(e.estimate({ size: 'large' }).p50Ms).toBeGreaterThan(e.estimate({ size: 'small' }).p50Ms);
  });

  it('prefers higher quality signals', () => {
    const mixed = [
      ...many(20, 10),
      ...many(20, 300, { activeMs: undefined, signal: 'low' }),
    ];
    expect(new Estimator(mixed).estimate({}).p50Ms).toBeLessThan(60 * MIN);
  });
});

describe('honest limits', () => {
  it('refuses to estimate from nothing rather than making up a number', () => {
    expect(() => new Estimator([]).estimate({ brief: 'x' })).toThrow(NoHistoryError);
    expect(() => new Estimator([session(10, { outcome: 'failed' })]).estimate({})).toThrow(NoHistoryError);
  });

  it('gives a real range and low confidence from a single session', () => {
    const e = new Estimator([session(30)]).estimate({ brief: 'x' });
    expect(e.confidence).toBe('low');
    expect(e.n).toBe(1);
    expect(e.p80Ms).toBeGreaterThan(e.p50Ms * 1.4);
    expect(e.p95Ms).toBeGreaterThan(e.p80Ms);
    expect(e.caveats.join(' ')).toMatch(/widened/);
  });

  it('gets narrower as the same spread gains samples', () => {
    const spread = (count: number) => {
      const sessions = Array.from({ length: count }, (_, i) => session(10 * Math.exp((i / (count - 1) - 0.5) * 2)));
      const e = new Estimator(sessions, { topK: count }).estimate({});
      return e.p95Ms / e.p50Ms;
    };
    expect(spread(4)).toBeGreaterThan(spread(50));
  });

  it('never rates a broad class as high confidence', () => {
    const e = new Estimator(many(60, 10)).estimate({});
    expect(e.class.level).toBe('global');
    expect(e.confidence).toBe('medium');
  });

  it('rates a well sampled specific class as high', () => {
    const e = new Estimator(many(60, 10, { repo: 'api' })).estimate({ repo: 'api' });
    expect(e.confidence).toBe('high');
  });

  it('warns when most comparables only have stamps', () => {
    const e = new Estimator(many(20, 10, { activeMs: undefined, signal: 'low' })).estimate({});
    expect(e.caveats.join(' ')).toMatch(/idle time/);
  });

  it('can hide one session for leave-one-out', () => {
    const only = session(10);
    expect(() => new Estimator([only]).estimate({}, only.id)).toThrow(NoHistoryError);
  });
});

describe('calibration from recorded actuals', () => {
  const history = many(30, 10, { repo: 'api' });

  it('shifts and spreads the range while keeping the raw numbers', () => {
    const plain = new Estimator(history).estimate({ repo: 'api' });
    const e = new Estimator(history, { calibration: { n: 12, shift: Math.log(2), spread: 1.5 } }).estimate({ repo: 'api' });
    expect(e.p50Ms).toBeCloseTo(plain.p50Ms * 2, 0);
    expect(e.p80Ms / e.p50Ms).toBeGreaterThan(plain.p80Ms / plain.p50Ms);
    expect(e.raw.p50Ms).toBeCloseTo(plain.p50Ms, 0);
    expect(e.caveats.join(' ')).toMatch(/12 recorded/);
  });
});
