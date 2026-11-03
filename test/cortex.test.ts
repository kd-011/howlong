import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { cortexSource, unionMs } from '../src/sources/cortex.js';
import { loadSqlite } from '../src/sources/sqlite.js';
import { generateSessions, writeCortexDb } from '../src/synthetic.js';
import type { Session } from '../src/types.js';
import { MIN, tempDir } from './helpers.js';

async function collect(path: string, opts = {}): Promise<Session[]> {
  const out: Session[] = [];
  for await (const s of cortexSource(path, opts).sessions()) out.push(s);
  return out;
}

/** One row with defaults, for cases the generated history does not cover. */
async function dbWith(rows: Record<string, unknown>[], turns: unknown[][] = [], sends: unknown[][] = []) {
  const path = join(tempDir(), 'one.db');
  await writeCortexDb(path, []);
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(path);
  for (const row of rows) {
    const full: Record<string, unknown> = { kind: 'pr', status: 'idle', created_at: 0, updated_at: 3_600_000, ...row };
    const cols = Object.keys(full);
    db.prepare(`INSERT INTO code_sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(full) as never[]));
  }
  for (const t of turns) db.prepare(`INSERT INTO code_turn_submissions (id, session_id, message, state, created_at, accepted_at, finished_at) VALUES (?,?,?,?,?,?,?)`).run(...(t as never[]));
  for (const s of sends) db.prepare(`INSERT INTO code_turn_authors (session_id, author, sent_at, display_text, model) VALUES (?,?,?,?,?)`).run(...(s as never[]));
  db.close();
  return path;
}

describe('cortex adapter on a generated history', () => {
  const synthetic = generateSessions(200, 3);
  let path: string;
  let sessions: Session[];

  beforeAll(async () => {
    path = join(tempDir(), 'cortex.db');
    await writeCortexDb(path, synthetic);
    sessions = await collect(path);
  });

  it('reads every session and uses the best signal each row offers', () => {
    expect(sessions).toHaveLength(200);
    const by = (signal: string) => sessions.filter((s) => s.signal === signal).length;
    expect(by('high')).toBe(150);
    expect(by('medium')).toBe(30);
    expect(by('low')).toBe(20);
  });

  it('recovers active time from turn spans, leaving out the waits between turns', () => {
    for (const s of sessions.filter((x) => x.signal === 'high')) {
      const truth = synthetic.find((t) => t.id === s.id)!;
      const sum = truth.turns.reduce((acc, [a, b]) => acc + b - a, 0);
      expect(s.activeMs).toBe(sum);
      expect(s.startedAt).toBe(truth.turns[0]![0]);
      expect(s.endedAt).toBe(truth.turns.at(-1)![1]);
    }
  });

  it('flags rows with only stamps as low and gives them no active time', () => {
    for (const s of sessions.filter((x) => x.signal === 'low')) expect(s.activeMs).toBeUndefined();
  });

  it('maps features across', () => {
    const s = sessions.at(-1)!;
    const truth = synthetic.find((t) => t.id === s.id)!;
    expect(s.repo).toBe(truth.repo);
    expect(s.model).toBe(truth.model);
    expect(s.scopeCount).toBe(truth.scopeCount);
    expect(s.title).toBe(truth.title);
    expect(s.briefChars).toBe(truth.brief.length);
    expect(s.text).toContain(truth.title);
    expect(s.tokens).toBe(truth.tokens);
  });

  it('never changes the database file', async () => {
    const before = readFileSync(path);
    await collect(path);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('cortex adapter on specific rows', () => {
  it('prefers turn times over stamps polluted by a later archive', async () => {
    const path = await dbWith(
      [{ id: 'a', updated_at: 5 * 86_400_000, archived_at: 5 * 86_400_000, merged_at: 40 * MIN }],
      [['t', 'a', 'do it', 'completed', 0, 1000, 20 * MIN]],
    );
    const [s] = await collect(path);
    expect(s!.signal).toBe('high');
    expect(s!.activeMs).toBe(20 * MIN - 1000);
    expect(s!.endedAt).toBe(20 * MIN);
  });

  it('falls back to message gaps when the turn table only caught the tail', async () => {
    const path = await dbWith(
      [{ id: 'a', last_turn_finished_at: 80 * MIN }],
      [['t', 'a', 'later turn', 'completed', 60 * MIN, 60 * MIN, 80 * MIN]],
      [['a', 'user', 0, 'first', null], ['a', 'user', 10 * MIN, 'second', null], ['a', 'user', 60 * MIN, 'third', null]],
    );
    const [s] = await collect(path);
    expect(s!.signal).toBe('medium');
    // 10m gap counts, 50m gap is idle, 20m tail counts.
    expect(s!.activeMs).toBe(30 * MIN);
    expect(s!.startedAt).toBe(0);
    expect(s!.endedAt).toBe(80 * MIN);
  });

  it('counts overlapping turns once', () => {
    expect(unionMs([[0, 10], [5, 15], [20, 30]])).toBe(25);
    expect(unionMs([[20, 30], [0, 100]])).toBe(100);
  });

  it('derives outcomes', async () => {
    const path = await dbWith([
      { id: 'merged', merged_at: 1000, archived_at: 2000 },
      { id: 'discarded', archived_at: 2000 },
      { id: 'errored', status: 'error' },
      { id: 'replaced', superseded_by: 'other' },
      { id: 'chat', kind: 'interactive', last_turn_state: 'completed' },
      { id: 'open' },
    ]);
    const outcome = Object.fromEntries((await collect(path)).map((s) => [s.id, s.outcome]));
    expect(outcome).toEqual({ merged: 'merged', discarded: 'abandoned', errored: 'failed', replaced: 'failed', chat: 'completed', open: 'unknown' });
  });

  it('skips sessions still running and kinds that are not build work', async () => {
    const path = await dbWith([
      { id: 'running', status: 'working' },
      { id: 'accepted', last_turn_state: 'accepted' },
      { id: 'job', kind: 'job' },
      { id: 'real' },
    ]);
    expect((await collect(path)).map((s) => s.id)).toEqual(['real']);
    expect((await collect(path, { kinds: ['job'] })).map((s) => s.id)).toEqual(['job']);
  });

  it('treats the auto model as no model, and uses the path tail as the repo', async () => {
    const path = await dbWith([{ id: 'a', model: 'auto', pr_repo: '/some/where/widget', repo: '/tmp/worktree-x' }]);
    const [s] = await collect(path);
    expect(s!.model).toBeUndefined();
    expect(s!.repo).toBe('widget');
  });

  it('copes with an older schema that lacks the turn tables and newer columns', async () => {
    const path = join(tempDir(), 'old.db');
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE code_sessions (id TEXT, title TEXT, created_at INTEGER, updated_at INTEGER);
             INSERT INTO code_sessions VALUES ('a', 'old work', 0, 600000);`);
    db.close();
    const [s] = await collect(path);
    expect(s!.signal).toBe('low');
    expect(s!.endedAt - s!.startedAt).toBe(10 * MIN);
  });

  it('reads a live WAL database without blocking a writer', async () => {
    const path = await dbWith([{ id: 'committed' }]);
    const { DatabaseSync } = await loadSqlite();
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec('BEGIN IMMEDIATE');
    writer.exec(`INSERT INTO code_sessions (id, kind, status, created_at, updated_at) VALUES ('pending', 'pr', 'idle', 0, 1000)`);
    expect((await collect(path)).map((s) => s.id)).toEqual(['committed']);
    writer.exec('COMMIT');
    expect((await collect(path)).map((s) => s.id)).toEqual(['committed', 'pending']);
    writer.close();
  });

  it('cannot write through its own handle', async () => {
    const path = await dbWith([{ id: 'a' }]);
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    expect(() => db.exec(`DELETE FROM code_sessions`)).toThrow(/readonly/);
    db.close();
  });

  it('says so when the file is some other database', async () => {
    const path = join(tempDir(), 'other.db');
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE unrelated (x)');
    db.close();
    await expect(collect(path)).rejects.toThrow(/not a Cortex database/);
  });
});
