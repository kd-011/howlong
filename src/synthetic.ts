import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gaussian, mulberry32 } from './stats.js';
import { loadSqlite } from './sources/sqlite.js';

/**
 * Seeded fake history. Everything here is invented, with durations driven by
 * known factors (repo, task type, model) plus lognormal noise, so tests and the
 * demo can check that the estimator recovers them.
 */
export interface SyntheticSession {
  id: string;
  title: string;
  brief: string;
  repo: string;
  model: string;
  scopeCount: number;
  startedAt: number;
  /** Agent working spans. */
  turns: [number, number][];
  activeMs: number;
  outcome: 'merged' | 'abandoned' | 'failed';
  /** Set when the row was left open and bumped long after the work ended. */
  idleBumpMs: number;
  tokens: number;
  costUsd: number;
}

const REPOS: [string, number][] = [['billing-api', 14], ['storefront', 24], ['ops-scripts', 8], ['mobile-app', 38]];
const MODELS: [string, number][] = [['model-fast', 1.25], ['model-deep', 0.9]];
const TASKS: { verb: string; factor: number; nouns: string[]; detail: string }[] = [
  { verb: 'Fix', factor: 0.55, nouns: ['flaky login test', 'null crash in checkout', 'wrong tax rounding', 'broken pagination'], detail: 'Reproduce the bug, add a regression test and fix the root cause.' },
  { verb: 'Add', factor: 1, nouns: ['rate limiting middleware', 'csv export endpoint', 'webhook retry queue', 'dark mode toggle'], detail: 'Build the feature behind a flag, cover it with tests and update the docs.' },
  { verb: 'Refactor', factor: 1.5, nouns: ['session storage layer', 'payment provider client', 'settings form components', 'job scheduler module'], detail: 'Split the module, keep behaviour identical and migrate every caller.' },
  { verb: 'Migrate', factor: 2.4, nouns: ['database driver to the new major version', 'auth flow to passkeys', 'build pipeline to the new bundler', 'search index to the new schema'], detail: 'Plan the cutover, move the data, run both paths side by side and remove the old one.' },
];

const BASE_TIME = Date.UTC(2026, 0, 5, 1);
const MIN = 60_000;

export function generateSessions(count = 400, seed = 42): SyntheticSession[] {
  const rand = mulberry32(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]!;
  const out: SyntheticSession[] = [];
  let clock = BASE_TIME;
  for (let i = 0; i < count; i++) {
    clock += Math.round((1 + rand() * 7) * 60 * MIN);
    const [repo, base] = pick(REPOS);
    const [model, speed] = pick(MODELS);
    const task = pick(TASKS);
    const noun = pick(task.nouns);
    const scopeCount = 1 + Math.floor(rand() * 4);
    const activeMs = Math.round(base * task.factor * speed * (1 + 0.15 * scopeCount) * Math.exp(0.45 * gaussian(rand)) * MIN);

    const turnCount = 1 + Math.floor(rand() * 3);
    const turns: [number, number][] = [];
    let t = clock;
    for (let k = 0; k < turnCount; k++) {
      const span = Math.round(activeMs / turnCount);
      turns.push([t, t + span]);
      t += span + Math.round((2 + rand() * 15) * MIN);
    }
    const roll = rand();
    out.push({
      id: `syn-${String(i).padStart(4, '0')}`,
      title: `${task.verb} ${noun}`,
      brief: `${task.verb} ${noun} in ${repo}. ${task.detail}`.repeat(1 + Math.floor(rand() * 3)),
      repo,
      model,
      scopeCount,
      startedAt: clock,
      turns,
      activeMs,
      outcome: roll < 0.88 ? 'merged' : roll < 0.95 ? 'abandoned' : 'failed',
      idleBumpMs: rand() < 0.08 ? Math.round((1 + rand() * 6) * 1440 * MIN) : 0,
      tokens: Math.round(activeMs / 20),
      costUsd: Math.round(activeMs / 3000) / 100,
    });
    clock = t;
  }
  return out;
}

/** Writes the subset of the Cortex schema the adapter reads. */
export async function writeCortexDb(path: string, sessions: SyntheticSession[]): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE code_sessions (
      id TEXT PRIMARY KEY, title TEXT, oc_title TEXT, directory TEXT, repo TEXT, pr_repo TEXT, mode TEXT,
      status TEXT, model TEXT, kind TEXT, cost_usd REAL, tokens INTEGER, archived_at INTEGER, merged_at INTEGER,
      closed_at INTEGER, created_at INTEGER, updated_at INTEGER, last_turn_state TEXT, last_turn_message TEXT,
      last_turn_finished_at INTEGER, retry_stage INTEGER, superseded_by TEXT, scopes TEXT);
    CREATE TABLE code_turn_submissions (
      id TEXT PRIMARY KEY, session_id TEXT, message TEXT, state TEXT,
      created_at INTEGER, accepted_at INTEGER, finished_at INTEGER);
    CREATE TABLE code_turn_authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, author TEXT, sent_at INTEGER, display_text TEXT, model TEXT);
  `);
  const insertSession = db.prepare(`INSERT INTO code_sessions VALUES (?,?,NULL,?,?,?,'build',?,?,'pr',?,?,?,?,NULL,?,?,?,?,?,0,NULL,?)`);
  const insertTurn = db.prepare(`INSERT INTO code_turn_submissions VALUES (?,?,?,'completed',?,?,?)`);
  const insertSend = db.prepare(`INSERT INTO code_turn_authors (session_id, author, sent_at, display_text, model) VALUES (?,'user',?,?,?)`);
  db.exec('BEGIN');
  sessions.forEach((s, i) => {
    const end = s.turns.at(-1)![1];
    // Older rows lose their finer signals, the way a tool's early history tends to.
    const hasTurnTimes = i >= sessions.length * 0.25;
    const hasSends = i >= sessions.length * 0.1;
    const merged = s.outcome === 'merged' ? end + 5 * MIN : null;
    const archived = s.outcome === 'abandoned' ? end + 60 * MIN : merged;
    insertSession.run(
      s.id, s.title, `/work/${s.repo}`, `/work/${s.repo}`, `/work/${s.repo}`,
      s.outcome === 'failed' ? 'error' : 'idle', s.model, s.costUsd, s.tokens, archived, merged, s.startedAt - MIN,
      end + 5 * MIN + s.idleBumpMs, s.outcome === 'failed' ? 'failed' : 'completed', s.brief,
      hasSends ? end : null, JSON.stringify(Array.from({ length: s.scopeCount }, (_, k) => `area-${k}`)),
    );
    s.turns.forEach(([a, b], k) => {
      if (hasTurnTimes) insertTurn.run(`${s.id}-${k}`, s.id, k === 0 ? s.brief : 'Continue', a - 1000, a, b);
      if (hasSends) insertSend.run(s.id, a, k === 0 ? s.brief : 'Continue', s.model);
    });
  });
  db.exec('COMMIT');
  db.close();
}

/** Writes Claude Code style transcripts, with a few junk lines to chew on. */
export function writeClaudeTree(root: string, sessions: SyntheticSession[]): void {
  rmSync(root, { recursive: true, force: true });
  for (const s of sessions) {
    const cwd = `/work/${s.repo}`;
    const dir = join(root, `-work-${s.repo}`);
    mkdirSync(dir, { recursive: true });
    const line = (type: string, at: number, message: unknown) =>
      JSON.stringify({ type, timestamp: new Date(at).toISOString(), sessionId: s.id, cwd, isSidechain: false, permissionMode: 'default', message });
    const lines: string[] = ['{"type":"last-prompt","lastPrompt":"ignored"}'];
    s.turns.forEach(([a, b], k) => {
      lines.push(line('user', a, { role: 'user', content: k === 0 ? s.brief : 'Carry on with the next part.' }));
      const assistant = (at: number) =>
        line('assistant', at, {
          role: 'assistant',
          model: s.model,
          usage: { input_tokens: Math.round(s.tokens / 8), output_tokens: Math.round(s.tokens / 24) },
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/file-${k}.ts` } }],
        });
      // Real transcripts log every few minutes, so no gap reads as idle.
      for (let at = a + 10 * MIN; at + MIN < b; at += 10 * MIN) {
        lines.push(assistant(at), line('user', at + MIN, { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }));
      }
      lines.push(assistant(b));
      if (k === 0) lines.push('{"type":"user", this line is cut off');
    });
    writeFileSync(join(dir, `${s.id}.jsonl`), `${lines.join('\n')}\n`);
  }
}

export const SAMPLE_PLAN = {
  repo: 'storefront',
  steps: [
    { id: 'schema', brief: 'Migrate the database driver to the new major version' },
    { id: 'api', brief: 'Add csv export endpoint', dependsOn: ['schema'] },
    { id: 'ui', brief: 'Add dark mode toggle to the settings form', dependsOn: ['schema'] },
    { id: 'tests', brief: 'Fix flaky login test and cover the export', dependsOn: ['api', 'ui'] },
  ],
};

export async function writeDemo(dir: string, count = 400, seed = 42): Promise<void> {
  const sessions = generateSessions(count, seed);
  await writeCortexDb(join(dir, 'cortex.db'), sessions);
  writeClaudeTree(join(dir, 'claude'), sessions);
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(SAMPLE_PLAN, null, 2)}\n`);
}
