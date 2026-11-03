import { Estimator, type Estimate } from './estimator.js';
import { gaussian, mulberry32, normalCdf, plainQuantile, quantile, type Dist } from './stats.js';
import type { Confidence, ExpectedSize, Range } from './types.js';

export interface PlanStep {
  id: string;
  brief?: string;
  dependsOn?: string[];
  repo?: string;
  model?: string;
  scopeCount?: number;
  size?: ExpectedSize;
}

export interface Plan {
  steps: PlanStep[];
  repo?: string;
  model?: string;
  concurrency?: number;
}

export interface SimOptions {
  /** Steps that may run at once. Default unlimited. */
  concurrency?: number;
  trials?: number;
  seed?: number;
  /**
   * Correlation between step durations. Steps in one plan share an agent and a
   * codebase, so they tend to overrun together, and sampling them independently
   * makes totals look far more certain than they are.
   */
  correlation?: number;
}

export interface SimResult {
  total: Range;
  serial: Range;
  /** Share of trials each step sat on the path that set the finish time. */
  criticality: Record<string, number>;
}

export interface PlanEstimate extends SimResult {
  concurrency: number | 'unlimited';
  trials: number;
  steps: (Range & {
    id: string;
    n: number;
    confidence: Confidence;
    class: string;
    criticality: number;
    caveats: string[];
  })[];
  caveats: string[];
}

/** Rejects duplicates, unknown dependencies and cycles. Returns dependents in index form. */
export function validatePlan(steps: Pick<PlanStep, 'id' | 'dependsOn'>[]): number[][] {
  if (steps.length === 0) throw new Error('A plan needs at least one step.');
  const at = new Map<string, number>();
  steps.forEach((s, i) => {
    if (!s.id) throw new Error(`Step ${i + 1} has no id.`);
    if (at.has(s.id)) throw new Error(`Duplicate step id "${s.id}".`);
    at.set(s.id, i);
  });
  const deps = steps.map((s) =>
    (s.dependsOn ?? []).map((d) => {
      const j = at.get(d);
      if (j === undefined) throw new Error(`Step "${s.id}" depends on unknown step "${d}".`);
      return j;
    }),
  );
  const state = new Uint8Array(steps.length);
  const visit = (i: number, path: string[]): void => {
    if (state[i] === 2) return;
    const id = steps[i]!.id;
    if (state[i] === 1) throw new Error(`Dependency cycle: ${[...path, id].join(' -> ')}.`);
    state[i] = 1;
    for (const j of deps[i]!) visit(j, [...path, id]);
    state[i] = 2;
  };
  steps.forEach((_, i) => visit(i, []));
  return deps;
}

/**
 * Monte Carlo over list scheduling: a step starts once its dependencies are done
 * and a slot is free, earliest in plan order first. With unlimited concurrency
 * this reduces to the critical path.
 */
export function simulate(
  steps: { id: string; dependsOn?: string[]; dist: Dist }[],
  opts: SimOptions = {},
): SimResult {
  const deps = validatePlan(steps);
  const n = steps.length;
  const limit = opts.concurrency ?? Infinity;
  if (!(limit >= 1)) throw new Error('Concurrency must be at least 1.');
  const trials = opts.trials ?? 10_000;
  const rho = Math.min(Math.max(opts.correlation ?? 0.3, 0), 1);
  const rand = mulberry32(opts.seed ?? 1);
  const dependents: number[][] = steps.map(() => []);
  deps.forEach((list, i) => list.forEach((j) => dependents[j]!.push(i)));

  const totals: number[] = [];
  const serials: number[] = [];
  const onPath = new Float64Array(n);
  const durations = new Float64Array(n);
  const blocker = new Int32Array(n);
  const waiting = new Int32Array(n);

  for (let t = 0; t < trials; t++) {
    const shared = gaussian(rand);
    let serial = 0;
    for (let i = 0; i < n; i++) {
      const z = Math.sqrt(rho) * shared + Math.sqrt(1 - rho) * gaussian(rand);
      durations[i] = quantile(steps[i]!.dist, normalCdf(z));
      serial += durations[i]!;
      waiting[i] = deps[i]!.length;
      blocker[i] = -1;
    }
    const ready: number[] = [];
    for (let i = 0; i < n; i++) if (waiting[i] === 0) ready.push(i);
    const running: { i: number; end: number }[] = [];
    let now = 0;
    let last = -1;
    let trigger = -1;
    while (ready.length > 0 || running.length > 0) {
      while (ready.length > 0 && running.length < limit) {
        const i = ready.shift()!;
        blocker[i] = trigger;
        running.push({ i, end: now + durations[i]! });
      }
      let next = 0;
      for (let r = 1; r < running.length; r++) if (running[r]!.end < running[next]!.end) next = r;
      const done = running.splice(next, 1)[0]!;
      now = done.end;
      last = done.i;
      trigger = done.i;
      for (const d of dependents[done.i]!) {
        waiting[d]!--;
        if (waiting[d] === 0) {
          // Keep plan order so the result does not depend on finish order.
          const pos = ready.findIndex((r) => r > d);
          if (pos === -1) ready.push(d);
          else ready.splice(pos, 0, d);
        }
      }
    }
    totals.push(now);
    serials.push(serial);
    for (let i = last; i !== -1; i = blocker[i]!) onPath[i]!++;
  }

  const criticality: Record<string, number> = {};
  steps.forEach((s, i) => (criticality[s.id] = Math.round((onPath[i]! / trials) * 100) / 100));
  return { total: rangeOf(totals), serial: rangeOf(serials), criticality };
}

function rangeOf(values: number[]): Range {
  return {
    p50Ms: plainQuantile(values, 0.5),
    p80Ms: plainQuantile(values, 0.8),
    p95Ms: plainQuantile(values, 0.95),
  };
}

export function estimatePlan(estimator: Estimator, plan: Plan, opts: SimOptions = {}): PlanEstimate {
  validatePlan(plan.steps);
  const concurrency = opts.concurrency ?? plan.concurrency;
  const estimates: Estimate[] = plan.steps.map((step) =>
    estimator.estimate({
      brief: step.brief ?? step.id,
      repo: step.repo ?? plan.repo,
      model: step.model ?? plan.model,
      scopeCount: step.scopeCount,
      size: step.size,
    }),
  );
  const trials = opts.trials ?? 10_000;
  const sim = simulate(
    plan.steps.map((s, i) => ({ id: s.id, dependsOn: s.dependsOn, dist: estimates[i]!.dist })),
    { ...opts, trials, concurrency },
  );
  const lowSteps = estimates.filter((e) => e.confidence === 'low').length;
  return {
    ...sim,
    concurrency: concurrency ?? 'unlimited',
    trials,
    steps: plan.steps.map((s, i) => {
      const e = estimates[i]!;
      return {
        id: s.id,
        p50Ms: e.p50Ms,
        p80Ms: e.p80Ms,
        p95Ms: e.p95Ms,
        n: e.n,
        confidence: e.confidence,
        class: e.class.label,
        criticality: sim.criticality[s.id]!,
        caveats: e.caveats,
      };
    }),
    caveats: lowSteps > 0 ? [`${lowSteps} of ${plan.steps.length} steps have low confidence.`] : [],
  };
}
