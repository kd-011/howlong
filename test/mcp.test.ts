import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp.js';
import { Store } from '../src/store.js';
import { writeDemo } from '../src/synthetic.js';
import { tempDir } from './helpers.js';

let client: Client;

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text;
}

function json(result: unknown) {
  const body = text(result);
  return JSON.parse(body.slice(body.indexOf('\n\n{') + 2));
}

beforeAll(async () => {
  const dir = tempDir();
  await writeDemo(dir, 120);
  const server = createServer([`cortex:${join(dir, 'cortex.db')}`], {}, new Store(tempDir()));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

describe('mcp server', () => {
  it('lists exactly its four tools, telling agents when to call them', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['backtest', 'estimate', 'estimate_plan', 'record_actual']);
    const estimate = tools.find((t) => t.name === 'estimate')!;
    expect(estimate.description).toMatch(/how long will this take/);
    expect(estimate.description).toMatch(/human timelines/);
  });

  it('runs estimate then record_actual', async () => {
    const result = await client.callTool({ name: 'estimate', arguments: { brief: 'Fix flaky login test', repo: 'storefront' } });
    const body = json(result);
    expect(body.p50Ms).toBeLessThan(body.p95Ms);
    expect(body.dist).toBeUndefined();
    const recorded = await client.callTool({ name: 'record_actual', arguments: { id: body.id, actual: '30m' } });
    expect(text(recorded)).toMatch(/Recorded 30m/);
  });

  it('runs estimate_plan with a dependency and a limit', async () => {
    const result = await client.callTool({
      name: 'estimate_plan',
      arguments: { concurrency: 1, steps: [{ id: 'a', brief: 'Add thing' }, { id: 'b', brief: 'Fix thing', dependsOn: ['a'] }] },
    });
    const body = json(result);
    expect(body.steps).toHaveLength(2);
    expect(body.concurrency).toBe(1);
  });

  it('runs backtest', async () => {
    const body = json(await client.callTool({ name: 'backtest', arguments: { limit: 30 } }));
    expect(body.evaluated).toBeGreaterThan(0);
    expect(body.calibration).toHaveLength(6);
  });

  it('reports errors as tool errors rather than crashing', async () => {
    const result = await client.callTool({ name: 'record_actual', arguments: { id: 'nope', actual: '5m' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No estimate/);
    const bad = await client.callTool({ name: 'estimate_plan', arguments: { steps: [{ id: 'a', dependsOn: ['b'] }] } });
    expect(bad.isError).toBe(true);
  });
});
