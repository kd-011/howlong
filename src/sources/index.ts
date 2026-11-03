import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configFile, dataDir } from '../paths.js';
import type { Session, SessionSource } from '../types.js';
import { claudeSource } from './claude-jsonl.js';
import { cortexSource } from './cortex.js';

export { claudeSource, cortexSource };

export interface SourceOptions {
  idleMs?: number;
  maxFiles?: number;
}

/** Turns `cortex:/path/to.db`, `claude` or `claude:/path` into a source. */
export function parseSource(spec: string, opts: SourceOptions = {}): SessionSource {
  const [kind, ...rest] = spec.split(':');
  const path = rest.join(':');
  const idle = opts.idleMs ? { idleMs: opts.idleMs } : {};
  if (kind === 'cortex') {
    if (!path) throw new Error('The cortex source needs a path: cortex:/path/to/cortex.db');
    if (!existsSync(path)) throw new Error(`No database at ${path}.`);
    return cortexSource(path, idle);
  }
  if (kind === 'claude') {
    return claudeSource({
      ...(path ? { root: path } : {}),
      ...idle,
      ...(opts.maxFiles ? { maxFiles: opts.maxFiles } : {}),
      cacheDir: join(dataDir(), 'cache'),
    });
  }
  throw new Error(`Unknown source "${spec}". Use cortex:/path/to/db or claude[:/path].`);
}

/** Flag, then HOWLONG_SOURCE, then the config file, then Claude Code's default folder. */
export function resolveSpecs(flag: string[] | undefined, env = process.env): string[] {
  if (flag?.length) return flag;
  if (env.HOWLONG_SOURCE) return env.HOWLONG_SOURCE.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const config = JSON.parse(readFileSync(configFile(env), 'utf8')) as { sources?: string[] };
    if (config.sources?.length) return config.sources;
  } catch {
    // No config file is the normal case.
  }
  if (existsSync(join(homedir(), '.claude', 'projects'))) return ['claude'];
  throw new Error('No session source. Pass --source cortex:/path/to/db or --source claude:/path.');
}

export async function loadSessions(specs: string[], opts: SourceOptions = {}): Promise<Session[]> {
  const out: Session[] = [];
  for (const spec of specs) {
    for await (const s of parseSource(spec, opts).sessions()) out.push(s);
  }
  return out;
}
