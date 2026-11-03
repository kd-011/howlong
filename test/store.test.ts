import { describe, expect, it } from 'vitest';
import { calibrationFrom, Store, summarize, type StoredEstimate } from '../src/store.js';
import { MIN, tempDir } from './helpers.js';

const base = { kind: 'single' as const, p50Ms: 10 * MIN, p80Ms: 20 * MIN, p95Ms: 40 * MIN, rawP50Ms: 10 * MIN, rawP80Ms: 20 * MIN };

function pairs(count: number, actualMin: (i: number) => number): StoredEstimate[] {
  return Array.from({ length: count }, (_, i) => ({ ...base, id: `e${i}`, at: i, actualMs: actualMin(i) * MIN }));
}

describe('Store', () => {
  it('saves an estimate then an actual across instances', () => {
    const dir = tempDir();
    const { id } = new Store(dir).add({ ...base, brief: 'thing' });
    const entry = new Store(dir).record(id, 15 * MIN);
    expect(entry.actualMs).toBe(15 * MIN);
    expect(new Store(dir).all()[0]!.actualMs).toBe(15 * MIN);
    expect(new Store(dir).all()[0]!.brief).toBe('thing');
  });

  it('accepts a unique id prefix and refuses an ambiguous or unknown one', () => {
    const store = new Store(tempDir());
    const a = store.add(base);
    expect(store.record(a.id.slice(0, 6), MIN).id).toBe(a.id);
    expect(() => store.record('zzzz', MIN)).toThrow(/No estimate/);
    store.add(base);
    expect(() => store.record('', MIN)).toThrow(/matches 2/);
  });

  it('refuses a zero or negative actual', () => {
    const store = new Store(tempDir());
    const { id } = store.add(base);
    expect(() => store.record(id, 0)).toThrow(/above zero/);
  });

  it('starts empty and reports a corrupt file instead of overwriting it', async () => {
    const dir = tempDir();
    const store = new Store(dir);
    expect(store.all()).toEqual([]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(store.file, 'not json');
    expect(() => store.all()).toThrow(/not valid JSON/);
    expect(() => store.add(base)).toThrow(/not valid JSON/);
  });
});

describe('calibrationFrom', () => {
  it('does nothing below the minimum sample', () => {
    expect(calibrationFrom(pairs(9, () => 100))).toBeUndefined();
  });

  it('ignores plan totals and estimates with no actual', () => {
    const entries = pairs(20, () => 10).map((e, i) => (i % 2 ? { ...e, kind: 'plan' as const } : { ...e, actualMs: undefined }));
    expect(calibrationFrom(entries)).toBeUndefined();
  });

  it('learns a shift from consistent overruns', () => {
    const c = calibrationFrom(pairs(12, () => 20))!;
    expect(Math.exp(c.shift)).toBeCloseTo(2);
    expect(c.spread).toBe(1);
  });

  it('never narrows the range', () => {
    expect(calibrationFrom(pairs(20, () => 10))!.spread).toBe(1);
  });

  it('widens when actuals scatter beyond what the range claimed', () => {
    const c = calibrationFrom(pairs(20, (i) => (i % 2 ? 1 : 100)))!;
    expect(c.spread).toBeGreaterThan(1);
    expect(c.spread).toBeLessThanOrEqual(3);
  });

  it('learns from raw numbers, so applying a correction does not compound it', () => {
    const entries = pairs(12, () => 20).map((e) => ({ ...e, p50Ms: 20 * MIN, p80Ms: 40 * MIN }));
    expect(Math.exp(calibrationFrom(entries)!.shift)).toBeCloseTo(2);
  });
});

describe('summarize', () => {
  it('reports coverage and pending ids', () => {
    const entries = [...pairs(4, (i) => [5, 15, 30, 50][i]!), { ...base, id: 'waiting', at: 9 }];
    const s = summarize(entries);
    expect(s.estimates).toBe(5);
    expect(s.recorded).toBe(4);
    expect(s.coverage).toEqual({ p50: 0.25, p80: 0.5, p95: 0.75 });
    expect(s.pending.map((e) => e.id)).toEqual(['waiting']);
    expect(s.calibration).toBeNull();
  });

  it('has no coverage with no actuals', () => {
    expect(summarize([]).coverage).toBeNull();
  });
});
