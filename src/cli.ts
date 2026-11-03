#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { backtest } from './backtest.js';
import { Estimator, NoHistoryError, type Estimate } from './estimator.js';
import { formatBacktest, formatDuration, formatEstimate, formatPlan, parseDuration } from './format.js';
import { serve } from './mcp.js';
import { estimatePlan, type Plan } from './plan.js';
import { loadSessions, parseSource, resolveSpecs, type SourceOptions } from './sources/index.js';
import { calibrationFrom, Store, summarize } from './store.js';
import { writeDemo } from './synthetic.js';
import type { ExpectedSize, Session } from './types.js';

const USAGE = `howlong: time estimates for coding-agent work, learned from your own finished sessions.

  howlong estimate "<brief>" [--repo R] [--model M] [--scopes N] [--size small|medium|large]
  howlong plan plan.json [--concurrency N] [--trials N] [--correlation 0..1]
  howlong backtest [--method rolling|loo] [--limit N]
  howlong record [<id> <duration>]
  howlong sources
  howlong mcp
  howlong demo [dir]

Common flags:
  --source S     cortex:/path/to/db, claude or claude:/path. Repeatable.
                 Defaults to HOWLONG_SOURCE, then the config file, then claude.
  --idle D       Gap that ends a session or stops counting as active. Default 30m.
  --max-files N  Read only the N newest Claude transcripts.
  --no-save      Do not store this estimate for later calibration.
  --json         Machine-readable output.`;

const COMMON = {
  source: { type: 'string', multiple: true },
  idle: { type: 'string' },
  'max-files': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number of at least 1.`);
  return n;
}

function sourceOptions(values: { idle?: string; 'max-files'?: string }): SourceOptions {
  const maxFiles = positiveInt(values['max-files'], '--max-files');
  return {
    ...(values.idle ? { idleMs: parseDuration(values.idle) } : {}),
    ...(maxFiles ? { maxFiles } : {}),
  };
}

function print(json: boolean | undefined, value: unknown, human: string): void {
  console.log(json ? JSON.stringify(value, null, 2) : human);
}

/** Estimate as it should leave the process: no internal distribution. */
export function publicEstimate(e: Estimate, id?: string) {
  const { dist: _dist, raw: _raw, ...rest } = e;
  return { ...(id ? { id } : {}), ...rest };
}

async function history(values: Parameters<typeof sourceOptions>[0] & { source?: string[] }): Promise<Session[]> {
  return loadSessions(resolveSpecs(values.source), sourceOptions(values));
}

async function cmdEstimate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...COMMON,
      repo: { type: 'string' },
      model: { type: 'string' },
      scopes: { type: 'string' },
      size: { type: 'string' },
      'no-save': { type: 'boolean' },
    },
  });
  const brief = positionals.join(' ').trim();
  if (!brief && !values.repo && !values.model) throw new Error('Give a brief, or at least --repo or --model.');
  if (values.size && !['small', 'medium', 'large'].includes(values.size)) {
    throw new Error('--size must be small, medium or large.');
  }
  const store = new Store();
  const calibration = calibrationFrom(store.all());
  const estimator = new Estimator(await history(values), calibration ? { calibration } : {});
  const scopeCount = positiveInt(values.scopes, '--scopes');
  const estimate = estimator.estimate({
    ...(brief ? { brief } : {}),
    ...(values.repo ? { repo: values.repo } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(scopeCount ? { scopeCount } : {}),
    ...(values.size ? { size: values.size as ExpectedSize } : {}),
  });
  const id = values['no-save']
    ? undefined
    : store.add({
        kind: 'single',
        ...(brief ? { brief } : {}),
        ...(values.repo ? { repo: values.repo } : {}),
        ...(values.model ? { model: values.model } : {}),
        p50Ms: estimate.p50Ms,
        p80Ms: estimate.p80Ms,
        p95Ms: estimate.p95Ms,
        rawP50Ms: estimate.raw.p50Ms,
        rawP80Ms: estimate.raw.p80Ms,
      }).id;
  print(values.json, publicEstimate(estimate, id), formatEstimate(estimate, id));
}

async function cmdPlan(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...COMMON,
      concurrency: { type: 'string' },
      trials: { type: 'string' },
      seed: { type: 'string' },
      correlation: { type: 'string' },
      'no-save': { type: 'boolean' },
    },
  });
  if (!positionals[0]) throw new Error('Give a plan file: howlong plan plan.json');
  const parsed = JSON.parse(readFileSync(positionals[0], 'utf8')) as Plan | Plan['steps'];
  const plan: Plan = Array.isArray(parsed) ? { steps: parsed } : parsed;
  if (!Array.isArray(plan.steps)) throw new Error('A plan file needs a "steps" array.');
  const store = new Store();
  const calibration = calibrationFrom(store.all());
  const estimator = new Estimator(await history(values), calibration ? { calibration } : {});
  const concurrency = positiveInt(values.concurrency, '--concurrency');
  const trials = positiveInt(values.trials, '--trials');
  const seed = positiveInt(values.seed, '--seed');
  const correlation = values.correlation === undefined ? undefined : Number(values.correlation);
  if (correlation !== undefined && !(correlation >= 0 && correlation <= 1)) {
    throw new Error('--correlation must be between 0 and 1.');
  }
  const result = estimatePlan(estimator, plan, {
    ...(concurrency ? { concurrency } : {}),
    ...(trials ? { trials } : {}),
    ...(seed ? { seed } : {}),
    ...(correlation !== undefined ? { correlation } : {}),
  });
  const id = values['no-save']
    ? undefined
    : store.add({
        kind: 'plan',
        brief: plan.steps.map((s) => s.id).join(', '),
        ...result.total,
        rawP50Ms: result.total.p50Ms,
        rawP80Ms: result.total.p80Ms,
      }).id;
  print(values.json, { ...(id ? { id } : {}), ...result }, formatPlan(result, id));
}

async function cmdBacktest(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { ...COMMON, method: { type: 'string' }, limit: { type: 'string' } },
  });
  if (values.method && values.method !== 'rolling' && values.method !== 'loo') {
    throw new Error('--method must be rolling or loo.');
  }
  const limit = positiveInt(values.limit, '--limit');
  const report = backtest(await history(values), {
    ...(values.method ? { method: values.method as 'rolling' | 'loo' } : {}),
    ...(limit ? { limit } : {}),
  });
  print(values.json, report, formatBacktest(report));
}

async function cmdRecord(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const store = new Store();
  if (positionals.length >= 2) {
    const entry = store.record(positionals[0]!, parseDuration(positionals.slice(1).join('')));
    const verdict = entry.actualMs! <= entry.p80Ms ? 'inside' : 'outside';
    print(values.json, entry, `Recorded ${formatDuration(entry.actualMs!)} against ${entry.id}: ${verdict} its P80 of ${formatDuration(entry.p80Ms)}.`);
    return;
  }
  if (positionals.length === 1) throw new Error('Give the duration too: howlong record <id> 45m');
  const s = summarize(store.all());
  const lines = [`${s.estimates} estimates saved, ${s.recorded} with actuals.`];
  if (s.coverage) lines.push(`Under P50 ${Math.round(s.coverage.p50 * 100)}%, under P80 ${Math.round(s.coverage.p80 * 100)}%, under P95 ${Math.round(s.coverage.p95 * 100)}%.`);
  lines.push(
    s.calibration
      ? `Future estimates shift by x${Math.exp(s.calibration.shift).toFixed(2)} and spread by x${s.calibration.spread.toFixed(2)}.`
      : 'At least 10 single-estimate actuals are needed before they adjust anything.',
  );
  if (s.pending.length) lines.push('Waiting on actuals:');
  for (const e of s.pending) lines.push(`  ${e.id}  ${(e.brief ?? '').slice(0, 60)}`);
  print(values.json, s, lines.join('\n'));
}

async function cmdSources(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: COMMON });
  const opts = sourceOptions(values);
  const rows = [];
  for (const spec of resolveSpecs(values.source)) {
    const signals = { high: 0, medium: 0, low: 0 };
    let n = 0;
    let first = Infinity;
    let last = 0;
    for await (const s of parseSource(spec, opts).sessions()) {
      n++;
      signals[s.signal]++;
      first = Math.min(first, s.startedAt);
      last = Math.max(last, s.endedAt);
    }
    rows.push({ source: spec, sessions: n, signals, ...(n ? { from: new Date(first).toISOString(), to: new Date(last).toISOString() } : {}) });
  }
  const human = rows
    .map((r) => {
      const range = r.from ? `, ${r.from.slice(0, 10)} to ${r.to!.slice(0, 10)}` : '';
      return `${r.source}: ${r.sessions} sessions${range}. Duration signal: ${r.signals.high} high, ${r.signals.medium} medium, ${r.signals.low} low.`;
    })
    .join('\n');
  print(values.json, rows, human);
}

async function cmdDemo(args: string[]): Promise<void> {
  const dir = args[0] ?? 'howlong-demo';
  await writeDemo(dir);
  console.log(`Wrote invented sessions to ${dir}/. Try:

  howlong estimate "Add csv export endpoint" --repo storefront --source cortex:${dir}/cortex.db
  howlong estimate "Fix flaky login test" --source claude:${dir}/claude
  howlong plan ${dir}/plan.json --source cortex:${dir}/cortex.db --concurrency 2
  howlong backtest --source cortex:${dir}/cortex.db`);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h' || rest.includes('--help') || rest.includes('-h')) {
      console.log(USAGE);
      return 0;
    }
    if (command === 'estimate') await cmdEstimate(rest);
    else if (command === 'plan') await cmdPlan(rest);
    else if (command === 'backtest') await cmdBacktest(rest);
    else if (command === 'record') await cmdRecord(rest);
    else if (command === 'sources') await cmdSources(rest);
    else if (command === 'demo') await cmdDemo(rest);
    else if (command === 'mcp') {
      const { values } = parseArgs({ args: rest, options: COMMON });
      await serve(resolveSpecs(values.source), sourceOptions(values));
    } else {
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return err instanceof NoHistoryError ? 2 : 1;
  }
}

// npm links bins through a symlink, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  // The MCP server keeps running on its stdio transport.
  process.exitCode = code;
}
