import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/types.js';

export const MIN = 60_000;
export const BASE = Date.UTC(2026, 0, 1);

let counter = 0;

export function session(minutes: number, over: Partial<Session> = {}): Session {
  const id = `s${counter++}`;
  const startedAt = over.startedAt ?? BASE + counter * 3 * 3_600_000;
  return {
    id,
    source: 'test',
    startedAt,
    endedAt: startedAt + minutes * MIN,
    activeMs: minutes * MIN,
    signal: 'high',
    outcome: 'merged',
    briefChars: 100,
    scopeCount: 0,
    ...over,
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'howlong-test-'));
}
