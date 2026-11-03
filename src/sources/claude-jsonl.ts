import { createReadStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Session, SessionSource } from '../types.js';

export interface ClaudeOptions {
  root?: string;
  /** A quiet gap this long followed by a new prompt starts a new session. */
  idleMs?: number;
  /** Parse only the N most recently modified transcripts. */
  maxFiles?: number;
  /** Where to keep per-file results. Off when undefined. */
  cacheDir?: string;
}

interface Event {
  at: number;
  human: boolean;
  text?: string;
  chars?: number;
  model?: string;
  tokens: number;
  files: string[];
  cwd?: string;
  mode?: string;
}

const DEFAULT_IDLE_MS = 30 * 60_000;
const MAX_LINE = 8_000_000;
const CACHE_VERSION = 1;

/** Agent tools tend to suffix worktree folders with a short random id. */
export function repoFromCwd(cwd: string, home = homedir()): string | undefined {
  if (!cwd || cwd === home || cwd === '/') return undefined;
  const nested = cwd.match(/^(.*)\/\.claude\/worktrees\/[^/]+/);
  const name = basename(nested ? nested[1]! : cwd);
  const suffix = name.match(/^(.+)-([a-z0-9]{6,10})$/);
  if (suffix && /\d/.test(suffix[2]!) && /[a-z]/.test(suffix[2]!)) return suffix[1];
  return name;
}

function promptText(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) return undefined;
    text = content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
  }
  text = text?.trim();
  if (!text) return undefined;
  // Slash commands, command output and injected reminders all arrive as user lines.
  if (/^<[a-z][a-z-]*[ >]/.test(text)) return undefined;
  return text;
}

function parseLine(line: string): Event | undefined {
  if (line.length > MAX_LINE) return undefined;
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return undefined;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if ((o?.type !== 'user' && o?.type !== 'assistant') || o.isSidechain) return undefined;
  const at = Date.parse(o.timestamp);
  if (!Number.isFinite(at)) return undefined;
  const event: Event = { at, human: false, tokens: 0, files: [], cwd: o.cwd, mode: o.permissionMode };
  if (o.type === 'user') {
    const text = o.isMeta || o.isCompactSummary ? undefined : promptText(o.message?.content);
    if (text) {
      event.human = true;
      event.text = text.slice(0, 2000);
      event.chars = text.length;
    }
  } else {
    const model = o.message?.model;
    if (typeof model === 'string' && !model.startsWith('<')) event.model = model;
    const usage = o.message?.usage;
    event.tokens = (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0);
    if (Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) {
          const file = b.input?.file_path ?? b.input?.notebook_path;
          if (typeof file === 'string') event.files.push(file);
        }
      }
    }
  }
  return event;
}

/**
 * Turns one transcript's events into sessions. A new session starts at a human
 * prompt after a quiet gap. Agent activity after a gap with no prompt is the
 * same job resuming, say after a long tool call, so it stays in the session and
 * only the gap goes uncounted. Gaps that end in a prompt are the person
 * thinking, not the agent working, so they do not count as active either.
 */
export function sessionize(events: Event[], id: string, idleMs: number): Session[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const runs: { events: Event[]; activeMs: number }[] = [];
  let run: { events: Event[]; activeMs: number } | undefined;
  for (const e of sorted) {
    const prev = run?.events.at(-1);
    const gap = prev ? e.at - prev.at : 0;
    if (!run || (gap >= idleMs && e.human)) {
      run = { events: [e], activeMs: 0 };
      runs.push(run);
      continue;
    }
    if (gap < idleMs && !e.human) run.activeMs += gap;
    run.events.push(e);
  }

  const out: Session[] = [];
  for (const r of runs) {
    const first = r.events.find((e) => e.human);
    if (!first || r.events.length < 2) continue;
    const startedAt = r.events[0]!.at;
    const models = new Map<string, number>();
    let tokens = 0;
    const files = new Set<string>();
    for (const e of r.events) {
      if (e.model) models.set(e.model, (models.get(e.model) ?? 0) + 1);
      tokens += e.tokens;
      for (const f of e.files) files.add(f);
    }
    const model = [...models].sort((a, b) => b[1] - a[1])[0]?.[0];
    const cwd = r.events.find((e) => e.cwd)?.cwd;
    const repo = cwd ? repoFromCwd(cwd) : undefined;
    const text = first.text ?? '';
    out.push({
      id: `${id}:${startedAt}`,
      source: 'claude-jsonl',
      ...(repo ? { repo } : {}),
      title: text.split('\n')[0]!.slice(0, 80),
      text,
      startedAt,
      endedAt: r.events.at(-1)!.at,
      activeMs: r.activeMs,
      signal: 'medium',
      ...(model ? { model } : {}),
      ...(first.mode ? { mode: first.mode } : {}),
      outcome: 'unknown',
      briefChars: first.chars ?? 0,
      scopeCount: 0,
      ...(files.size ? { filesTouched: files.size } : {}),
      ...(tokens ? { tokens } : {}),
    });
  }
  return out;
}

export async function parseTranscript(path: string, idleMs = DEFAULT_IDLE_MS): Promise<Session[]> {
  const events: Event[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return sessionize(events, basename(path, '.jsonl'), idleMs);
}

async function listTranscripts(root: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const out: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Subagent transcripts run inside a parent session; counting them would double it.
        if (entry.name !== 'subagents') await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(path).catch(() => undefined);
        if (info) out.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };
  await walk(root);
  return out;
}

interface CacheFile {
  version: number;
  idleMs: number;
  files: Record<string, { size: number; mtimeMs: number; sessions: Session[] }>;
}

async function readCache(file: string, idleMs: number): Promise<CacheFile['files']> {
  try {
    const cache = JSON.parse(await readFile(file, 'utf8')) as CacheFile;
    return cache.version === CACHE_VERSION && cache.idleMs === idleMs ? cache.files : {};
  } catch {
    return {};
  }
}

async function writeCache(file: string, idleMs: number, files: CacheFile['files']): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, idleMs, files }), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/**
 * Reads Claude Code transcripts line by line. Malformed lines are skipped.
 * Parsing a large history takes a while, so results are cached per file and only
 * files whose size or mtime changed are read again.
 */
export function claudeSource(opts: ClaudeOptions = {}): SessionSource {
  const root = opts.root ?? join(homedir(), '.claude', 'projects');
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  return {
    name: `claude:${root}`,
    async *sessions() {
      let files = await listTranscripts(root);
      if (opts.maxFiles) files = files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, opts.maxFiles);
      const cacheFile = opts.cacheDir ? join(opts.cacheDir, 'claude-transcripts.json') : undefined;
      const cached = cacheFile ? await readCache(cacheFile, idleMs) : {};
      const next: CacheFile['files'] = {};
      // A resumed session can replay old lines into a new file.
      const seen = new Set<string>();
      for (const f of files) {
        const hit = cached[f.path];
        const sessions =
          hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs
            ? hit.sessions
            : await parseTranscript(f.path, idleMs).catch(() => []);
        next[f.path] = { size: f.size, mtimeMs: f.mtimeMs, sessions };
        for (const s of sessions) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          yield s;
        }
      }
      if (cacheFile) await writeCache(cacheFile, idleMs, next);
    },
  };
}
