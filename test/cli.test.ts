import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { resolveSpecs } from '../src/sources/index.js';
import { tempDir } from './helpers.js';

const dir = tempDir();
const cortex = `cortex:${join(dir, 'cortex.db')}`;
const claude = `claude:${join(dir, 'claude')}`;

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((m) => void out.push(String(m)));
  const error = vi.spyOn(console, 'error').mockImplementation((m) => void err.push(String(m)));
  const code = await main(argv);
  log.mockRestore();
  error.mockRestore();
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeAll(async () => {
  vi.stubEnv('HOWLONG_HOME', tempDir());
  vi.stubEnv('HOWLONG_SOURCE', '');
  expect((await run('demo', dir)).code).toBe(0);
});

afterEach(() => vi.restoreAllMocks());

describe('estimate', () => {
  it('prints a range with its confidence and class, from each adapter', async () => {
    for (const source of [cortex, claude]) {
      const { code, out } = await run('estimate', 'Add csv export endpoint', '--repo', 'storefront', '--source', source);
      expect(code).toBe(0);
      expect(out).toMatch(/^P50 .+ P80 .+ P95 .+ confidence\)/);
      expect(out).toContain('same repo "storefront"');
      expect(out).toContain('Add csv export endpoint');
    }
  });

  it('gives machine output without the internal distribution', async () => {
    const { out } = await run('estimate', 'Fix flaky login test', '--source', cortex, '--json');
    const parsed = JSON.parse(out);
    expect(parsed.p50Ms).toBeLessThan(parsed.p80Ms);
    expect(parsed.p80Ms).toBeLessThan(parsed.p95Ms);
    expect(parsed.id).toBeTruthy();
    expect(parsed.dist).toBeUndefined();
    expect(parsed.comparables.length).toBeGreaterThan(0);
  });

  it('does not save with --no-save', async () => {
    const { out } = await run('estimate', 'x y z', '--source', cortex, '--no-save');
    expect(out).not.toContain('Saved as');
  });

  it('exits 2 and says why when there is no history', async () => {
    const empty = tempDir();
    const { code, err } = await run('estimate', 'x', '--source', `claude:${empty}`);
    expect(code).toBe(2);
    expect(err).toMatch(/nothing to forecast/);
  });

  it.each([
    [['estimate'], /Give a brief/],
    [['estimate', 'x', '--size', 'huge', '--source', cortex], /--size/],
    [['estimate', 'x', '--source', 'cortex:/nope.db'], /No database/],
    [['estimate', 'x', '--source', 'cortex'], /needs a path/],
    [['estimate', 'x', '--source', 'other:/x'], /Unknown source/],
    [['plan'], /plan file/],
    [['plan', join(dir, 'plan.json'), '--source', cortex, '--correlation', '2'], /--correlation/],
    [['backtest', '--method', 'magic'], /--method/],
    [['record', 'abc'], /duration too/],
    [['nonsense'], /Unknown command/],
  ])('rejects bad input %j', async (argv, message) => {
    const { code, err } = await run(...(argv as string[]));
    expect(code).toBe(1);
    expect(err).toMatch(message as RegExp);
  });
});

describe('plan', () => {
  it('prints totals, the serial contrast and each step', async () => {
    const { code, out } = await run('plan', join(dir, 'plan.json'), '--source', cortex, '--concurrency', '2', '--trials', '500');
    expect(code).toBe(0);
    expect(out).toContain('at most 2 at once');
    expect(out).toContain('One step at a time');
    for (const step of ['schema', 'api', 'ui', 'tests']) expect(out).toContain(step);
  });

  it('accepts a bare array of steps and reports a cycle', async () => {
    const file = join(tempDir(), 'p.json');
    writeFileSync(file, JSON.stringify([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]));
    const { code, err } = await run('plan', file, '--source', cortex);
    expect(code).toBe(1);
    expect(err).toMatch(/cycle/);
  });
});

describe('backtest', () => {
  it('reports coverage and error, from each adapter', async () => {
    for (const source of [cortex, claude]) {
      const { code, out } = await run('backtest', '--source', source);
      expect(code).toBe(0);
      expect(out).toContain('P80');
      expect(out).toContain('Median absolute % error');
    }
  });

  it('gives machine output', async () => {
    const { out } = await run('backtest', '--source', cortex, '--method', 'loo', '--limit', '40', '--json');
    const parsed = JSON.parse(out);
    expect(parsed.method).toBe('loo');
    expect(parsed.evaluated).toBe(40);
    expect(parsed.calibration).toHaveLength(6);
  });
});

describe('record', () => {
  it('stores an actual against an estimate and reports it', async () => {
    const { out } = await run('estimate', 'Add dark mode toggle', '--source', cortex, '--json');
    const { id } = JSON.parse(out);
    const recorded = await run('record', id, '45m');
    expect(recorded.code).toBe(0);
    expect(recorded.out).toMatch(/Recorded 45m/);
    const summary = await run('record');
    expect(summary.out).toMatch(/with actuals/);
  });
});

describe('sources', () => {
  it('counts sessions and signal quality', async () => {
    const { out } = await run('sources', '--source', cortex, '--source', claude);
    expect(out).toMatch(/400 sessions/);
    expect(out).toMatch(/high/);
  });
});

describe('resolveSpecs', () => {
  it('prefers the flag, then the environment', () => {
    expect(resolveSpecs(['claude'], { HOWLONG_SOURCE: 'cortex:/x' })).toEqual(['claude']);
    expect(resolveSpecs(undefined, { HOWLONG_SOURCE: 'cortex:/x, claude' })).toEqual(['cortex:/x', 'claude']);
  });
});

describe('help', () => {
  it('prints usage', async () => {
    const { code, out } = await run('--help');
    expect(code).toBe(0);
    expect(out).toContain('howlong estimate');
  });
});
