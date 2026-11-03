import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Calibration } from './estimator.js';
import { dataDir } from './paths.js';
import { plainQuantile } from './stats.js';
import type { Range } from './types.js';

export interface StoredEstimate extends Range {
  id: string;
  at: number;
  kind: 'single' | 'plan';
  brief?: string;
  repo?: string;
  model?: string;
  /** Quantiles before any recorded-actuals adjustment, so learning never compounds on itself. */
  rawP50Ms: number;
  rawP80Ms: number;
  actualMs?: number;
  recordedAt?: number;
}

const MIN_FOR_CALIBRATION = 10;
const MAX_KEPT = 5000;

export class Store {
  readonly file: string;

  constructor(dir = dataDir()) {
    this.file = join(dir, 'store.json');
  }

  all(): StoredEstimate[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    try {
      return (JSON.parse(text) as { estimates: StoredEstimate[] }).estimates;
    } catch {
      throw new Error(`The store at ${this.file} is not valid JSON. Move it aside to start fresh.`);
    }
  }

  add(entry: Omit<StoredEstimate, 'id' | 'at'>): StoredEstimate {
    const saved: StoredEstimate = { id: randomBytes(4).toString('hex'), at: Date.now(), ...entry };
    this.write([...this.all(), saved].slice(-MAX_KEPT));
    return saved;
  }

  /** Accepts a unique id prefix, since these get typed by hand. */
  record(id: string, actualMs: number): StoredEstimate {
    if (!(actualMs > 0)) throw new Error('The actual duration must be above zero.');
    const entries = this.all();
    const matches = entries.filter((e) => e.id.startsWith(id));
    if (matches.length === 0) throw new Error(`No estimate with id "${id}".`);
    if (matches.length > 1) throw new Error(`"${id}" matches ${matches.length} estimates. Use more of the id.`);
    const entry = matches[0]!;
    entry.actualMs = actualMs;
    entry.recordedAt = Date.now();
    this.write(entries);
    return entry;
  }

  private write(estimates: StoredEstimate[]): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, estimates }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * Learns a correction from estimates with recorded actuals. Spread only ever
 * grows: a short run of lucky actuals should not talk the tool into narrower
 * ranges. Below a minimum sample there is no correction at all.
 */
export function calibrationFrom(entries: StoredEstimate[]): Calibration | undefined {
  const done = entries.filter((e) => e.kind === 'single' && e.actualMs !== undefined);
  if (done.length < MIN_FOR_CALIBRATION) return undefined;
  const ratios = done.map((e) => Math.log(e.actualMs! / e.rawP50Ms));
  const shift = plainQuantile(ratios, 0.5);
  const observed = plainQuantile(ratios.map((r) => r - shift), 0.8);
  const claimed = plainQuantile(done.map((e) => Math.log(e.rawP80Ms / e.rawP50Ms)), 0.5);
  const spread = claimed > 0 ? Math.min(Math.max(observed / claimed, 1), 3) : 1;
  return { n: done.length, shift, spread };
}

export function summarize(entries: StoredEstimate[]) {
  const done = entries.filter((e) => e.actualMs !== undefined);
  const under = (key: 'p50Ms' | 'p80Ms' | 'p95Ms') => done.filter((e) => e.actualMs! <= e[key]).length;
  return {
    estimates: entries.length,
    recorded: done.length,
    coverage: done.length
      ? { p50: under('p50Ms') / done.length, p80: under('p80Ms') / done.length, p95: under('p95Ms') / done.length }
      : null,
    pending: entries.filter((e) => e.actualMs === undefined).slice(-5).reverse(),
    calibration: calibrationFrom(entries) ?? null,
  };
}
