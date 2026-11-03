import type { BacktestReport } from './backtest.js';
import type { Estimate } from './estimator.js';
import type { PlanEstimate } from './plan.js';
import type { Range } from './types.js';

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses `45m`, `1h30m`, `2.5h`, `90s`. A bare number is refused: its unit would be a guess. */
export function parseDuration(text: string): number {
  const cleaned = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+(\.\d+)?[smhd])+$/.test(cleaned)) {
    throw new Error(`Cannot read "${text}" as a duration. Try 45m, 1h30m or 2.5h.`);
  }
  let ms = 0;
  for (const m of cleaned.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) ms += Number(m[1]) * UNITS[m[2]!]!;
  return ms;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return '<1m';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) {
    const min = totalMin % 60;
    return min ? `${totalHours}h ${min}m` : `${totalHours}h`;
  }
  const hours = Math.round((totalMin % 1440) / 60);
  const days = Math.floor(totalMin / 1440);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

function rangeLine(r: Range): string {
  return `P50 ${formatDuration(r.p50Ms)}   P80 ${formatDuration(r.p80Ms)}   P95 ${formatDuration(r.p95Ms)}`;
}

export function formatEstimate(e: Estimate, id?: string): string {
  const lines = [
    `${rangeLine(e)}   (${e.confidence} confidence)`,
    `From ${e.n} sessions, ${e.class.label}. Effective sample ${e.effectiveN}.`,
    ...e.caveats,
  ];
  const close = e.comparables.slice(0, 3);
  if (close.length) {
    lines.push('Closest past work:');
    for (const c of close) lines.push(`  ${formatDuration(c.durationMs).padEnd(7)} ${c.title ?? c.id}`);
  }
  if (id) lines.push(`Saved as ${id}. When it finishes: howlong record ${id} <duration>`);
  return lines.join('\n');
}

export function formatPlan(p: PlanEstimate, id?: string): string {
  const width = Math.max(...p.steps.map((s) => s.id.length), 4);
  const limit = p.concurrency === 'unlimited' ? 'no concurrency limit' : `at most ${p.concurrency} at once`;
  const lines = [
    `Plan total, ${limit}:`,
    `  ${rangeLine(p.total)}`,
    'One step at a time, for contrast:',
    `  ${rangeLine(p.serial)}`,
    '',
    `${'step'.padEnd(width)}  ${'P50'.padEnd(7)} ${'P80'.padEnd(7)} ${'P95'.padEnd(7)} ${'critical'.padEnd(8)} confidence`,
  ];
  for (const s of p.steps) {
    lines.push(
      `${s.id.padEnd(width)}  ${formatDuration(s.p50Ms).padEnd(7)} ${formatDuration(s.p80Ms).padEnd(7)} ${formatDuration(s.p95Ms).padEnd(7)} ${`${Math.round(s.criticality * 100)}%`.padEnd(8)} ${s.confidence}`,
    );
  }
  lines.push(...p.caveats);
  if (id) lines.push(`Saved as ${id}. When it finishes: howlong record ${id} <duration>`);
  return lines.join('\n');
}

const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`);

export function formatBacktest(r: BacktestReport): string {
  const method = r.method === 'rolling' ? 'rolling origin (each forecast sees only earlier sessions)' : 'leave one out';
  const lines = [
    `Backtest: ${method}`,
    `${r.evaluated} forecasts scored from ${r.usable} usable sessions.`,
    '',
    'Calibration, share of actuals at or under each quantile:',
    `  ${'quantile'.padEnd(10)}${'howlong'.padEnd(9)}${'95% CI'.padEnd(12)}plain median of all sessions`,
  ];
  r.calibration.forEach((c, k) => {
    const label = `P${Math.round(c.level * 100)}`;
    const ci = `${pct(c.ci[0])}-${pct(c.ci[1])}`;
    lines.push(`  ${label.padEnd(10)}${pct(c.observed).padEnd(9)}${ci.padEnd(12)}${pct(r.baseline.calibration[k]!.observed)}`);
  });
  lines.push(
    '',
    `Median absolute % error of P50: ${pct(r.mdape)} (plain median: ${pct(r.baseline.mdape)})`,
    `Median P95/P50 spread: ${r.medianSpread.toFixed(1)}x (plain median: ${r.baseline.medianSpread.toFixed(1)}x)`,
  );
  for (const [title, groups] of [['By reference class', r.byClass], ['By confidence label', r.byConfidence]] as const) {
    lines.push('', `${title}:`);
    for (const g of groups) {
      lines.push(`  ${g.group.padEnd(12)}n=${String(g.n).padEnd(6)}P80 coverage ${pct(g.coverageP80).padEnd(6)}error ${pct(g.mdape)}`);
    }
  }
  lines.push('', ...r.verdict);
  return lines.join('\n');
}
