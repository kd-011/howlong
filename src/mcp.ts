import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { backtest } from './backtest.js';
import { Estimator } from './estimator.js';
import { formatBacktest, formatDuration, formatEstimate, formatPlan, parseDuration } from './format.js';
import { estimatePlan } from './plan.js';
import { loadSessions, type SourceOptions } from './sources/index.js';
import { calibrationFrom, Store } from './store.js';
import type { Session } from './types.js';

const CACHE_MS = 5 * 60_000;

function reply(human: string, data: unknown) {
  return { content: [{ type: 'text' as const, text: `${human}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function guarded<A>(fn: (args: A) => Promise<ReturnType<typeof reply>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  };
}

/**
 * Sources come from server config, never tool arguments, so a prompt-injected
 * agent cannot point the server at some other database on the machine.
 */
export function createServer(specs: string[], sourceOpts: SourceOptions = {}, store = new Store()): McpServer {
  let cached: { at: number; sessions: Session[] } | undefined;
  const sessions = async () => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      cached = { at: Date.now(), sessions: await loadSessions(specs, sourceOpts) };
    }
    return cached.sessions;
  };
  const estimator = async () => {
    const calibration = calibrationFrom(store.all());
    return new Estimator(await sessions(), calibration ? { calibration } : {});
  };

  const server = new McpServer({ name: 'howlong', version: '0.1.0' });

  server.registerTool(
    'estimate',
    {
      description:
        'Call this whenever you are asked "how long will this take" or are about to give a time estimate for coding-agent work. Do not guess from human timelines: agents work at a different pace and your intuition about duration is unreliable. Returns a P50/P80/P95 wall-clock range from the user\'s own finished agent sessions, with the sample size, a confidence label and the comparable sessions used. Always report the range and the confidence, never a single number. Keep the returned id and call record_actual when the work finishes.',
      inputSchema: {
        brief: z.string().describe('What the work is, in the words you would brief an agent with.'),
        repo: z.string().optional().describe('Repository name, without the path.'),
        model: z.string().optional().describe('Model name or part of one, such as "opus".'),
        scopeCount: z.number().int().positive().optional().describe('Distinct areas of the codebase the work touches.'),
        size: z.enum(['small', 'medium', 'large']).optional().describe('Expected size, if you have a real reason to think so.'),
      },
      annotations: { title: 'Estimate one piece of work' },
    },
    guarded(async ({ brief, repo, model, scopeCount, size }) => {
      const e = (await estimator()).estimate({
        brief,
        ...(repo ? { repo } : {}),
        ...(model ? { model } : {}),
        ...(scopeCount ? { scopeCount } : {}),
        ...(size ? { size } : {}),
      });
      const { id } = store.add({
        kind: 'single',
        brief,
        ...(repo ? { repo } : {}),
        ...(model ? { model } : {}),
        p50Ms: e.p50Ms,
        p80Ms: e.p80Ms,
        p95Ms: e.p95Ms,
        rawP50Ms: e.raw.p50Ms,
        rawP80Ms: e.raw.p80Ms,
      });
      const { dist: _dist, raw: _raw, ...rest } = e;
      return reply(formatEstimate(e, id), { id, ...rest });
    }),
  );

  server.registerTool(
    'estimate_plan',
    {
      description:
        'Call this when asked how long a multi-step plan will take, instead of adding up guesses. Give the steps and their dependencies. Returns a range per step and a plan total from Monte Carlo simulation over the user\'s own session history, with parallel steps overlapping up to the concurrency limit, plus the one-at-a-time total for contrast.',
      inputSchema: {
        steps: z
          .array(
            z.object({
              id: z.string(),
              brief: z.string().optional(),
              dependsOn: z.array(z.string()).optional(),
              repo: z.string().optional(),
              model: z.string().optional(),
              scopeCount: z.number().int().positive().optional(),
              size: z.enum(['small', 'medium', 'large']).optional(),
            }),
          )
          .min(1),
        repo: z.string().optional().describe('Default repository for steps that do not name one.'),
        model: z.string().optional().describe('Default model for steps that do not name one.'),
        concurrency: z.number().int().positive().optional().describe('Most steps running at once. Unlimited if left out.'),
      },
      annotations: { title: 'Estimate a multi-step plan' },
    },
    guarded(async ({ steps, repo, model, concurrency }) => {
      const result = estimatePlan(await estimator(), {
        steps: steps.map((s) => ({
          id: s.id,
          ...(s.brief ? { brief: s.brief } : {}),
          ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
          ...(s.repo ? { repo: s.repo } : {}),
          ...(s.model ? { model: s.model } : {}),
          ...(s.scopeCount ? { scopeCount: s.scopeCount } : {}),
          ...(s.size ? { size: s.size } : {}),
        })),
        ...(repo ? { repo } : {}),
        ...(model ? { model } : {}),
        ...(concurrency ? { concurrency } : {}),
      });
      const { id } = store.add({
        kind: 'plan',
        brief: steps.map((s) => s.id).join(', '),
        ...result.total,
        rawP50Ms: result.total.p50Ms,
        rawP80Ms: result.total.p80Ms,
      });
      return reply(formatPlan(result, id), { id, ...result });
    }),
  );

  server.registerTool(
    'record_actual',
    {
      description:
        'Call this when work you estimated has finished, with the id from estimate or estimate_plan and how long it really took. Recorded actuals correct future estimates. Report the real time even when it looks bad.',
      inputSchema: {
        id: z.string().describe('The id returned with the estimate.'),
        actual: z.string().describe('How long it took, such as 45m, 1h30m or 2.5h.'),
      },
      annotations: { title: 'Record how long work really took', idempotentHint: true },
    },
    guarded(async ({ id, actual }) => {
      const entry = store.record(id, parseDuration(actual));
      const where = entry.actualMs! <= entry.p80Ms ? 'inside' : 'outside';
      return reply(`Recorded ${formatDuration(entry.actualMs!)}: ${where} the P80 of ${formatDuration(entry.p80Ms)}.`, entry);
    }),
  );

  server.registerTool(
    'backtest',
    {
      description:
        'Call this to find out whether howlong can be trusted on this history before leaning on its numbers. Replays past sessions as if they had not happened yet and reports how often actuals landed under each quantile, the median percentage error, and a comparison with a plain median of all sessions.',
      inputSchema: {
        method: z.enum(['rolling', 'loo']).optional().describe('rolling only uses earlier sessions and is the fair test. Default rolling.'),
        limit: z.number().int().positive().optional().describe('Most forecasts to score. Default 2000.'),
      },
      annotations: { title: 'Measure forecast accuracy on past sessions', readOnlyHint: true },
    },
    guarded(async ({ method, limit }) => {
      const report = backtest(await sessions(), { ...(method ? { method } : {}), ...(limit ? { limit } : {}) });
      return reply(formatBacktest(report), report);
    }),
  );

  return server;
}

export async function serve(specs: string[], sourceOpts: SourceOptions = {}): Promise<void> {
  await createServer(specs, sourceOpts).connect(new StdioServerTransport());
}
