import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeSource, parseTranscript, repoFromCwd } from '../src/sources/claude-jsonl.js';
import { generateSessions, writeClaudeTree } from '../src/synthetic.js';
import type { Session } from '../src/types.js';
import { BASE, MIN, tempDir } from './helpers.js';

const at = (minutes: number) => new Date(BASE + minutes * MIN).toISOString();
const prompt = (minutes: number, text: string, extra = {}) =>
  JSON.stringify({ type: 'user', timestamp: at(minutes), cwd: '/work/widget', permissionMode: 'plan', message: { role: 'user', content: text }, ...extra });
const toolResult = (minutes: number) =>
  JSON.stringify({ type: 'user', timestamp: at(minutes), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const reply = (minutes: number, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(minutes),
    message: { role: 'assistant', model: 'model-x', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] },
    ...extra,
  });

async function parse(lines: string[], opts?: number): Promise<Session[]> {
  const path = join(tempDir(), 'abc.jsonl');
  writeFileSync(path, lines.join('\n'));
  return parseTranscript(path, opts);
}

async function collect(source: ReturnType<typeof claudeSource>): Promise<Session[]> {
  const out: Session[] = [];
  for await (const s of source.sessions()) out.push(s);
  return out;
}

describe('parseTranscript', () => {
  it('measures one run from first to last message', async () => {
    const [s, ...rest] = await parse([prompt(0, 'Add a thing'), reply(5), toolResult(6), reply(12)]);
    expect(rest).toHaveLength(0);
    expect(s!.startedAt).toBe(BASE);
    expect(s!.endedAt).toBe(BASE + 12 * MIN);
    expect(s!.activeMs).toBe(12 * MIN);
    expect(s!.signal).toBe('medium');
    expect(s!.repo).toBe('widget');
    expect(s!.model).toBe('model-x');
    expect(s!.mode).toBe('plan');
    expect(s!.tokens).toBe(30);
    expect(s!.title).toBe('Add a thing');
    expect(s!.briefChars).toBe(11);
  });

  it('starts a new session at a prompt after a quiet gap', async () => {
    const sessions = await parse([prompt(0, 'first'), reply(10), prompt(100, 'second'), reply(115)]);
    expect(sessions.map((s) => s.title)).toEqual(['first', 'second']);
    expect(sessions.map((s) => s.activeMs)).toEqual([10 * MIN, 15 * MIN]);
  });

  it('honours a custom idle threshold', async () => {
    const lines = [prompt(0, 'first'), reply(10), prompt(20, 'second'), reply(25)];
    expect(await parse(lines)).toHaveLength(1);
    expect(await parse(lines, 5 * MIN)).toHaveLength(2);
  });

  it('does not count time a person spent before their next prompt', async () => {
    const [s] = await parse([prompt(0, 'first'), reply(5), prompt(20, 'and now this'), reply(30)]);
    expect(s!.endedAt - s!.startedAt).toBe(30 * MIN);
    expect(s!.activeMs).toBe(15 * MIN);
  });

  it('keeps agent activity after a long gap in the same session without counting the gap', async () => {
    const sessions = await parse([prompt(0, 'run the long build'), reply(10), toolResult(90), reply(95)]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedAt - sessions[0]!.startedAt).toBe(95 * MIN);
    expect(sessions[0]!.activeMs).toBe(15 * MIN);
  });

  it('skips malformed lines, truncated lines and unrelated record types', async () => {
    const sessions = await parse([
      '{not json',
      '{"type":"user", cut off',
      '',
      'null',
      '{"type":"user","timestamp":"not a date","message":{"content":"x"}}',
      '{"type":"summary","summary":"ignored"}',
      prompt(0, 'real'),
      reply(3),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.activeMs).toBe(3 * MIN);
  });

  it('survives a line far past the size limit', async () => {
    const huge = prompt(1, 'x'.repeat(9_000_000));
    const sessions = await parse([prompt(0, 'real'), reply(1), huge, reply(2)]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.activeMs).toBe(2 * MIN);
  });

  it('ignores sidechain lines and injected prompts when finding the brief', async () => {
    const [s] = await parse([
      prompt(0, '<command-name>/clear</command-name>'),
      prompt(0.5, 'meta line', { isMeta: true }),
      prompt(1, 'the real brief'),
      reply(2, { isSidechain: true }),
      reply(3),
    ]);
    expect(s!.title).toBe('the real brief');
    expect(s!.tokens).toBe(15);
  });

  it('drops runs with no human prompt or only one message', async () => {
    expect(await parse([reply(0), reply(1)])).toHaveLength(0);
    expect(await parse([prompt(0, 'lonely')])).toHaveLength(0);
  });

  it('counts distinct edited files', async () => {
    const edit = (m: number, file: string) =>
      JSON.stringify({ type: 'assistant', timestamp: at(m), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } });
    const [s] = await parse([prompt(0, 'go'), edit(1, 'a.ts'), edit(2, 'a.ts'), edit(3, 'b.ts')]);
    expect(s!.filesTouched).toBe(2);
  });

  it('accepts array content for the brief', async () => {
    const line = JSON.stringify({ type: 'user', timestamp: at(0), message: { content: [{ type: 'text', text: 'from blocks' }] } });
    const [s] = await parse([line, reply(1)]);
    expect(s!.title).toBe('from blocks');
  });
});

describe('repoFromCwd', () => {
  it('names the repo from a plain folder', () => expect(repoFromCwd('/work/widget', '/home/me')).toBe('widget'));
  it('sees through nested agent worktrees', () => expect(repoFromCwd('/work/widget/.claude/worktrees/abc', '/home/me')).toBe('widget'));
  it('strips a random worktree suffix', () => expect(repoFromCwd('/cache/widget-mw0qhlu3', '/home/me')).toBe('widget'));
  it('keeps ordinary hyphenated names', () => {
    expect(repoFromCwd('/work/my-widget', '/home/me')).toBe('my-widget');
    expect(repoFromCwd('/work/api-v2', '/home/me')).toBe('api-v2');
  });
  it('has no repo for the home folder', () => expect(repoFromCwd('/home/me', '/home/me')).toBeUndefined());
});

describe('claudeSource', () => {
  it('walks a tree of generated transcripts, skipping junk lines', async () => {
    const root = join(tempDir(), 'claude');
    const synthetic = generateSessions(30, 9);
    writeClaudeTree(root, synthetic);
    const sessions = await collect(claudeSource({ root }));
    expect(sessions).toHaveLength(30);
    const sum = (t: (typeof synthetic)[number]) => t.turns.reduce((acc, [a, b]) => acc + b - a, 0);
    for (const s of sessions) {
      const truth = synthetic.find((t) => s.id.startsWith(t.id))!;
      expect(s.repo).toBe(truth.repo);
      expect(s.activeMs).toBe(sum(truth));
    }
  });

  it('leaves subagent transcripts out', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'proj', 'one', 'subagents'), { recursive: true });
    writeFileSync(join(root, 'proj', 'one.jsonl'), [prompt(0, 'parent'), reply(1)].join('\n'));
    writeFileSync(join(root, 'proj', 'one', 'subagents', 'agent.jsonl'), [prompt(0, 'child'), reply(1)].join('\n'));
    expect((await collect(claudeSource({ root }))).map((s) => s.title)).toEqual(['parent']);
  });

  it('counts a session replayed into a second file once', async () => {
    const root = tempDir();
    const lines = [prompt(0, 'same'), reply(1)].join('\n');
    writeFileSync(join(root, 'one.jsonl'), lines);
    writeFileSync(join(root, 'one.copy.jsonl'), lines);
    const sessions = await collect(claudeSource({ root }));
    expect(new Set(sessions.map((s) => s.startedAt)).size).toBe(1);
  });

  it('limits to the newest files when asked', async () => {
    const root = tempDir();
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `${name}.jsonl`), [prompt(0, name), reply(1)].join('\n'));
    expect(await collect(claudeSource({ root, maxFiles: 2 }))).toHaveLength(2);
  });

  it('reuses the cache until a file changes', async () => {
    const root = tempDir();
    const cacheDir = tempDir();
    const file = join(root, 'one.jsonl');
    writeFileSync(file, [prompt(0, 'first'), reply(1)].join('\n'));
    const source = claudeSource({ root, cacheDir });
    expect((await collect(source))[0]!.activeMs).toBe(MIN);

    const cachePath = join(cacheDir, 'claude-transcripts.json');
    const { readFileSync, statSync } = await import('node:fs');
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(statSync(cachePath).mode & 0o077).toBe(0);
    cached.files[file].sessions[0].title = 'from cache';
    writeFileSync(cachePath, JSON.stringify(cached));
    expect((await collect(source))[0]!.title).toBe('from cache');

    appendFileSync(file, `\n${reply(4)}`);
    const after = await collect(source);
    expect(after[0]!.title).toBe('first');
    expect(after[0]!.activeMs).toBe(4 * MIN);
  });

  it('returns nothing for a missing folder', async () => {
    expect(await collect(claudeSource({ root: join(tempDir(), 'nope') }))).toEqual([]);
  });
});
