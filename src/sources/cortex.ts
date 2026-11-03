import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Outcome, Session, SessionSource, SignalQuality } from '../types.js';
import { loadSqlite } from './sqlite.js';

export interface CortexOptions {
  /** Session kinds that represent build work. Scheduled jobs and chat threads do not. */
  kinds?: string[];
  idleMs?: number;
}

type Row = Record<string, string | number | null>;
interface Turn {
  message: string | null;
  chars: number;
  created: number;
  accepted: number | null;
  finished: number | null;
}
interface Sent {
  at: number;
  text: string | null;
  model: string | null;
}

const DEFAULT_KINDS = ['pr', 'interactive', 'desktop'];
const DEFAULT_IDLE_MS = 30 * 60_000;

/** Merged length of possibly overlapping intervals. */
export function unionMs(intervals: [number, number][]): number {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    if (a > end) {
      total += b - a;
      end = b;
    } else if (b > end) {
      total += b - end;
      end = b;
    }
  }
  return total;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function select(columns: Set<string>, wanted: string[]): string {
  return wanted.map((c) => (columns.has(c) ? c : `NULL AS ${c}`)).join(', ');
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function pickOutcome(r: Row): Outcome {
  if (r.merged_at) return 'merged';
  if (r.status === 'error' || r.superseded_by || r.last_turn_state === 'failed' || r.last_turn_state === 'lost') {
    return 'failed';
  }
  if (r.kind === 'pr' && r.archived_at) return 'abandoned';
  if (r.last_turn_state === 'completed' || r.archived_at) return 'completed';
  return 'unknown';
}

function mostCommon(values: (string | null)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Reads the Cortex orchestrator's SQLite database. The handle is read-only and
 * query_only, and every query finishes before the next, so a live database never
 * sees a write or a long-held read.
 *
 * Duration, best signal first: per-turn accepted and finished times, then gaps
 * between turn send times, then the row's own stamps. updated_at gets bumped by
 * archiving, so it is the last resort and flagged low.
 */
export function cortexSource(path: string, opts: CortexOptions = {}): SessionSource {
  const kinds = new Set(opts.kinds ?? DEFAULT_KINDS);
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  return {
    name: `cortex:${path}`,
    async *sessions() {
      const { DatabaseSync } = await loadSqlite();
      const db = new DatabaseSync(path, { readOnly: true });
      let rows: Row[];
      let turns = new Map<string, (Turn & { session_id: string })[]>();
      let sends = new Map<string, (Sent & { session_id: string })[]>();
      try {
        db.exec('PRAGMA query_only = ON');
        db.exec('PRAGMA busy_timeout = 2000');
        const cols = tableColumns(db, 'code_sessions');
        if (cols.size === 0) throw new Error(`${path} has no code_sessions table, so it is not a Cortex database.`);
        rows = db
          .prepare(
            `SELECT ${select(cols, [
              'id', 'title', 'oc_title', 'directory', 'repo', 'pr_repo', 'mode', 'status', 'model', 'kind',
              'cost_usd', 'tokens', 'archived_at', 'merged_at', 'closed_at', 'created_at', 'updated_at',
              'last_turn_state', 'last_turn_message', 'last_turn_finished_at', 'retry_stage', 'superseded_by', 'scopes',
            ])} FROM code_sessions`,
          )
          .all() as Row[];
        if (tableColumns(db, 'code_turn_submissions').size > 0) {
          const all = db
            .prepare(
              `SELECT session_id, substr(message, 1, 2000) AS message, length(message) AS chars,
                      created_at AS created, accepted_at AS accepted, finished_at AS finished
               FROM code_turn_submissions ORDER BY created_at`,
            )
            .all() as unknown as (Turn & { session_id: string })[];
          turns = groupBy(all, (t) => t.session_id);
        }
        const authorCols = tableColumns(db, 'code_turn_authors');
        if (authorCols.size > 0) {
          const all = db
            .prepare(
              `SELECT session_id, sent_at AS at, ${select(authorCols, ['display_text'])}, ${select(authorCols, ['model'])}
               FROM code_turn_authors ORDER BY sent_at`,
            )
            .all() as unknown as { session_id: string; at: number; display_text: string | null; model: string | null }[];
          sends = groupBy(
            all.map((a) => ({ session_id: a.session_id, at: a.at, text: a.display_text, model: a.model })),
            (s) => s.session_id,
          );
        }
      } finally {
        db.close();
      }

      for (const r of rows) {
        if (r.kind && !kinds.has(String(r.kind))) continue;
        // Still running, so it has no finished duration to learn from.
        if (r.status === 'working' || r.last_turn_state === 'accepted') continue;
        const session = toSession(r, turns.get(String(r.id)) ?? [], sends.get(String(r.id)) ?? [], idleMs, path);
        if (session) yield session;
      }
    },
  };
}

function toSession(r: Row, turns: Turn[], sends: Sent[], idleMs: number, path: string): Session | undefined {
  const created = Number(r.created_at);
  const finished = r.last_turn_finished_at ? Number(r.last_turn_finished_at) : undefined;
  const closed = Number(r.merged_at || 0) || finished || Number(r.closed_at || 0) || Number(r.updated_at);

  let startedAt = created;
  let endedAt = closed;
  let activeMs: number | undefined;
  let signal: SignalQuality = 'low';

  const done = turns.filter((t) => t.finished !== null);
  const firstTurn = done[0] ? (done[0].accepted ?? done[0].created) : undefined;
  // Sends older than the first recorded turn mean the turn table only caught the tail.
  const partial = firstTurn !== undefined && sends[0] !== undefined && sends[0].at < firstTurn - 60_000;
  if (done.length > 0 && !partial && done.length === turns.length) {
    const spans = done.map((t): [number, number] => [t.accepted ?? t.created, t.finished!]);
    activeMs = unionMs(spans);
    startedAt = Math.min(...spans.map((s) => s[0]));
    endedAt = Math.max(...spans.map((s) => s[1]));
    signal = 'high';
  } else if (sends.length > 0 && finished !== undefined) {
    activeMs = 0;
    for (let i = 1; i < sends.length; i++) {
      const gap = sends[i]!.at - sends[i - 1]!.at;
      if (gap < idleMs) activeMs += gap;
    }
    const tail = finished - sends.at(-1)!.at;
    if (tail > 0 && tail < idleMs) activeMs += tail;
    startedAt = sends[0]!.at;
    endedAt = Math.max(finished, sends.at(-1)!.at);
    signal = 'medium';
  }
  if (!(endedAt > startedAt)) return undefined;

  const title = String(r.title && r.title !== 'untitled' ? r.title : (r.oc_title ?? '')) || undefined;
  const brief = turns[0]?.message ?? sends[0]?.text ?? (r.last_turn_message as string | null) ?? '';
  const repoPath = r.pr_repo ?? r.repo;
  const model = mostCommon(sends.map((s) => s.model)) ?? (r.model ? String(r.model) : undefined);
  const retries = Number(r.retry_stage ?? 0);
  return {
    id: String(r.id),
    source: `cortex:${path}`,
    ...(repoPath ? { repo: basename(String(repoPath)) } : {}),
    ...(title ? { title } : {}),
    text: `${title ?? ''}\n${brief}`.slice(0, 2200),
    startedAt,
    endedAt,
    ...(activeMs !== undefined ? { activeMs } : {}),
    signal,
    ...(model && model !== 'auto' ? { model } : {}),
    ...(r.mode ? { mode: String(r.mode) } : {}),
    outcome: pickOutcome(r),
    briefChars: turns[0]?.chars ?? brief.length,
    scopeCount: parseScopes(r.scopes),
    ...(retries ? { retries } : {}),
    ...(Number(r.tokens) > 0 ? { tokens: Number(r.tokens) } : {}),
    ...(Number(r.cost_usd) > 0 ? { costUsd: Number(r.cost_usd) } : {}),
  };
}

function parseScopes(value: Row[string] | undefined): number {
  if (typeof value !== 'string') return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
