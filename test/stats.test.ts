import { describe, expect, it } from 'vitest';
import { effectiveN, makeDist, mulberry32, normalCdf, normalInv, plainQuantile, quantile, wilson } from '../src/stats.js';

const uniform = (values: number[]) => makeDist(values.map((ms) => ({ ms, weight: 1 })));

describe('quantile', () => {
  it('interpolates the median of an even sample in log space', () => {
    expect(quantile(uniform([10, 40]), 0.5)).toBeCloseTo(20, 6);
  });

  it('moves toward heavily weighted samples', () => {
    const dist = makeDist([{ ms: 10, weight: 1 }, { ms: 100, weight: 9 }]);
    expect(quantile(dist, 0.5)).toBeGreaterThan(50);
  });

  it('stretches away from the median when widened and leaves the median alone', () => {
    const plain = uniform([10, 20, 40, 80, 160]);
    const wide = { ...plain, widen: 2 };
    expect(quantile(wide, 0.5)).toBeCloseTo(quantile(plain, 0.5), 6);
    expect(quantile(wide, 0.8)).toBeGreaterThan(quantile(plain, 0.8));
    expect(quantile(wide, 0.2)).toBeLessThan(quantile(plain, 0.2));
  });

  it('gives a single sample a real range through the sigma floor', () => {
    const dist = makeDist([{ ms: 100, weight: 1 }], { floorSigma: 0.6 });
    expect(quantile(dist, 0.5)).toBeCloseTo(100, 6);
    expect(quantile(dist, 0.8)).toBeGreaterThan(150);
    expect(quantile(dist, 0.95)).toBeGreaterThan(quantile(dist, 0.8));
  });

  it('applies a calibration shift to every quantile', () => {
    const plain = uniform([10, 20, 40]);
    expect(quantile({ ...plain, shift: Math.log(2) }, 0.5)).toBeCloseTo(40, 6);
  });

  it('refuses to build from nothing', () => {
    expect(() => makeDist([])).toThrow();
  });
});

describe('helpers', () => {
  it('normal CDF and quantile invert each other', () => {
    for (const p of [0.01, 0.1, 0.5, 0.8, 0.95, 0.999]) expect(normalCdf(normalInv(p))).toBeCloseTo(p, 4);
    expect(normalInv(0.975)).toBeCloseTo(1.96, 2);
  });

  it('seeded PRNG repeats and stays in range', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('effective N counts equal weights in full and discounts skew', () => {
    expect(effectiveN([1, 1, 1, 1])).toBe(4);
    expect(effectiveN([100, 1, 1, 1])).toBeLessThan(1.2);
  });

  it('Wilson interval brackets the proportion and tightens with n', () => {
    const [lo, hi] = wilson(80, 100);
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
    const [lo2, hi2] = wilson(800, 1000);
    expect(hi2 - lo2).toBeLessThan(hi - lo);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('plain quantile interpolates', () => {
    expect(plainQuantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(plainQuantile([], 0.5)).toBeNaN();
  });
});
