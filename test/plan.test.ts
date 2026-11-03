import { describe, expect, it } from 'vitest';
import { Estimator } from '../src/estimator.js';
import { estimatePlan, simulate, validatePlan } from '../src/plan.js';
import { makeDist, type Dist } from '../src/stats.js';
import { session } from './helpers.js';

/** Always exactly this long, so schedules can be checked by hand. */
const fixed = (ms: number): Dist => makeDist([{ ms, weight: 1 }]);
const spread = (ms: number): Dist =>
  makeDist(Array.from({ length: 50 }, (_, i) => ({ ms: ms * Math.exp((i / 49 - 0.5) * 2), weight: 1 })));
const fast = { trials: 50 };

describe('validatePlan', () => {
  it('rejects an empty plan', () => expect(() => validatePlan([])).toThrow(/at least one/));
  it('rejects duplicate ids', () => expect(() => validatePlan([{ id: 'a' }, { id: 'a' }])).toThrow(/Duplicate/));
  it('rejects unknown dependencies', () => expect(() => validatePlan([{ id: 'a', dependsOn: ['b'] }])).toThrow(/unknown step "b"/));
  it('rejects self dependency', () => expect(() => validatePlan([{ id: 'a', dependsOn: ['a'] }])).toThrow(/cycle/));
  it('names the steps in a cycle', () => {
    const plan = [{ id: 'a', dependsOn: ['c'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }];
    expect(() => validatePlan(plan)).toThrow(/cycle: a -> c -> b -> a/);
  });
  it('accepts a diamond', () => {
    const plan = [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['a'] }, { id: 'd', dependsOn: ['b', 'c'] }];
    expect(validatePlan(plan)[3]).toEqual([1, 2]);
  });
});

describe('simulate with fixed durations', () => {
  it('adds up a chain', () => {
    const r = simulate([
      { id: 'a', dist: fixed(10) },
      { id: 'b', dist: fixed(20), dependsOn: ['a'] },
      { id: 'c', dist: fixed(30), dependsOn: ['b'] },
    ], fast);
    expect(r.total.p50Ms).toBeCloseTo(60);
    expect(r.serial.p50Ms).toBeCloseTo(60);
  });

  it('overlaps parallel steps with no limit', () => {
    const r = simulate([{ id: 'a', dist: fixed(10) }, { id: 'b', dist: fixed(30) }, { id: 'c', dist: fixed(20) }], fast);
    expect(r.total.p95Ms).toBeCloseTo(30);
    expect(r.serial.p50Ms).toBeCloseTo(60);
  });

  it('takes the longer branch of a diamond', () => {
    const r = simulate([
      { id: 'a', dist: fixed(5) },
      { id: 'b', dist: fixed(10), dependsOn: ['a'] },
      { id: 'c', dist: fixed(40), dependsOn: ['a'] },
      { id: 'd', dist: fixed(5), dependsOn: ['b', 'c'] },
    ], fast);
    expect(r.total.p50Ms).toBeCloseTo(50);
    expect(r.criticality).toEqual({ a: 1, b: 0, c: 1, d: 1 });
  });

  it('runs one at a time when the limit is 1, even with no dependencies', () => {
    const r = simulate([{ id: 'a', dist: fixed(10) }, { id: 'b', dist: fixed(20) }, { id: 'c', dist: fixed(30) }], { ...fast, concurrency: 1 });
    expect(r.total.p50Ms).toBeCloseTo(60);
    expect(r.total.p50Ms).toBeCloseTo(r.serial.p50Ms);
  });

  it('packs into the slots available', () => {
    const steps = ['a', 'b', 'c', 'd'].map((id) => ({ id, dist: fixed(10) }));
    expect(simulate(steps, { ...fast, concurrency: 2 }).total.p50Ms).toBeCloseTo(20);
    expect(simulate(steps, { ...fast, concurrency: 3 }).total.p50Ms).toBeCloseTo(20);
    expect(simulate(steps, { ...fast, concurrency: 4 }).total.p50Ms).toBeCloseTo(10);
  });

  it('lets a released step take the first free slot', () => {
    const r = simulate([
      { id: 'long', dist: fixed(100) },
      { id: 'short', dist: fixed(10) },
      { id: 'after', dist: fixed(10), dependsOn: ['short'] },
    ], { ...fast, concurrency: 2 });
    expect(r.total.p50Ms).toBeCloseTo(100);
  });

  it('marks the blocking step critical when a slot, not a dependency, causes the wait', () => {
    const r = simulate([{ id: 'a', dist: fixed(10) }, { id: 'b', dist: fixed(20) }], { ...fast, concurrency: 1 });
    expect(r.criticality).toEqual({ a: 1, b: 1 });
  });

  it('refuses a limit below 1', () => {
    expect(() => simulate([{ id: 'a', dist: fixed(1) }], { concurrency: 0 })).toThrow(/Concurrency/);
  });
});

describe('simulate with uncertainty', () => {
  const parallel = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, dist: spread(1000) }));

  it('repeats exactly for a seed', () => {
    expect(simulate(parallel, { seed: 5, trials: 500 })).toEqual(simulate(parallel, { seed: 5, trials: 500 }));
  });

  it('shows the merge bias: waiting on many parallel steps beats the typical single step', () => {
    const r = simulate(parallel, { trials: 4000, correlation: 0 });
    expect(r.total.p50Ms).toBeGreaterThan(1500);
  });

  it('never finishes after the serial total and orders its quantiles', () => {
    const r = simulate(parallel, { trials: 2000, concurrency: 2 });
    expect(r.total.p50Ms).toBeLessThan(r.serial.p50Ms);
    expect(r.total.p50Ms).toBeLessThan(r.total.p80Ms);
    expect(r.total.p80Ms).toBeLessThan(r.total.p95Ms);
  });

  it('fewer slots take longer', () => {
    const at = (concurrency: number) => simulate(parallel, { trials: 2000, concurrency }).total.p80Ms;
    expect(at(1)).toBeGreaterThan(at(2));
    expect(at(2)).toBeGreaterThan(at(5));
  });

  it('correlated steps give wider totals than independent ones', () => {
    const chain = parallel.map((s, i) => ({ ...s, dependsOn: i ? [parallel[i - 1]!.id] : [] }));
    const width = (correlation: number) => {
      const r = simulate(chain, { trials: 4000, correlation });
      return r.total.p95Ms / r.total.p50Ms;
    };
    expect(width(1)).toBeGreaterThan(width(0) * 1.1);
  });

  it('with full correlation a chain total is the sum of step quantiles', () => {
    const chain = [
      { id: 'a', dist: spread(100) },
      { id: 'b', dist: spread(100), dependsOn: ['a'] },
    ];
    const one = simulate([chain[0]!], { trials: 8000, correlation: 1 });
    const two = simulate(chain, { trials: 8000, correlation: 1 });
    expect(two.total.p80Ms / one.total.p80Ms).toBeCloseTo(2, 1);
  });
});

describe('estimatePlan', () => {
  const history = [
    ...Array.from({ length: 30 }, (_, i) => session(10 + i * 0.3, { repo: 'api', text: 'fix small bug' })),
    ...Array.from({ length: 30 }, (_, i) => session(100 + i * 3, { repo: 'api', text: 'migrate whole database' })),
  ];
  const estimator = new Estimator(history);

  it('estimates each step from its own brief and reports totals', () => {
    const p = estimatePlan(estimator, {
      repo: 'api',
      steps: [
        { id: 'db', brief: 'migrate whole database' },
        { id: 'fix1', brief: 'fix small bug', dependsOn: ['db'] },
        { id: 'fix2', brief: 'fix small bug', dependsOn: ['db'] },
      ],
    }, { trials: 2000 });
    const [db, fix1] = p.steps;
    expect(db!.p50Ms).toBeGreaterThan(fix1!.p50Ms * 3);
    expect(db!.class).toContain('api');
    expect(db!.criticality).toBe(1);
    expect(p.total.p50Ms).toBeLessThan(p.serial.p50Ms);
    expect(p.total.p50Ms).toBeGreaterThan(db!.p50Ms);
    expect(p.concurrency).toBe('unlimited');
  });

  it('takes the limit from the plan or the options, with options winning', () => {
    const steps = [{ id: 'a' }, { id: 'b' }];
    expect(estimatePlan(estimator, { steps, concurrency: 1 }, { trials: 50 }).concurrency).toBe(1);
    expect(estimatePlan(estimator, { steps, concurrency: 1 }, { trials: 50, concurrency: 2 }).concurrency).toBe(2);
  });

  it('flags low confidence steps', () => {
    const thin = new Estimator([session(10)]);
    const p = estimatePlan(thin, { steps: [{ id: 'a' }] }, { trials: 50 });
    expect(p.caveats.join(' ')).toMatch(/low confidence/);
  });

  it('rejects a broken plan before doing any work', () => {
    expect(() => estimatePlan(estimator, { steps: [{ id: 'a', dependsOn: ['nope'] }] })).toThrow(/unknown/);
  });
});
