// Starts the built server over real stdio and checks its tool list.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = mkdtempSync(join(tmpdir(), 'howlong-mcp-'));
const { writeDemo } = await import('../dist/synthetic.js');
await writeDemo(dir, 120);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/cli.js', 'mcp', '--source', `cortex:${join(dir, 'cortex.db')}`],
  env: { ...process.env, HOWLONG_HOME: dir },
  stderr: 'inherit',
});
const client = new Client({ name: 'verify', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(names.join('\n'));
const expected = ['backtest', 'estimate', 'estimate_plan', 'record_actual'];
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`expected ${expected}`);
const result = await client.callTool({ name: 'estimate', arguments: { brief: 'Add csv export endpoint' } });
console.log(result.content[0].text.split('\n')[0]);
await client.close();
