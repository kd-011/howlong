# howlong

Evidence-based build-time estimates for coding-agent work.

Ask an agent how long something will take and it answers from human timelines: "2 to 3 days" for a job it finishes in forty minutes. howlong reads your own finished agent sessions, finds past work like the job in front of you, and reports the range those sessions took. It runs as a CLI, a library and an MCP server, and its backtest lets you check the numbers on your own history before you rely on them.

```
$ howlong estimate "Add csv export endpoint" --repo storefront --source cortex:howlong-demo/cortex.db
P50 31m   P80 1h 2m   P95 1h 20m   (medium confidence)
From 60 sessions, same repo "storefront". Effective sample 9.4.
Only about 9 comparable sessions, so the range was widened.
Closest past work:
  1h 2m   Add csv export endpoint
  27m     Add csv export endpoint
  19m     Add csv export endpoint
```

Every output on this page comes from the invented history that `howlong demo` generates.

## How it compares

| Tool | Where estimates come from | What it learns from | Accuracy check |
| --- | --- | --- | --- |
| howlong | Reference class over your finished sessions | Session logs, read automatically, plus actuals you record | Rolling-origin backtest over your sessions |
| [agent-estimation](https://github.com/ZhangHanDong/agent-estimation) | Agent skill, estimates in tool-call rounds | Nothing, it uses fixed anchors | None documented |
| [agent-time](https://github.com/ConnorBritain/agent-time) | Agent skill, estimates in rounds | Outcomes logged to a history file | None documented |
| [agent-estimate](https://github.com/kiloloop/agent-estimate) | PERT three-point with built-in priors | Nothing yet | None documented |
| [mcprojsim](https://github.com/johan162/mcprojsim) | Monte Carlo schedule for human teams | Imported sprint and velocity data | None documented |
| [Epoch](https://github.com/KyaniteLabs/Epoch) | PERT, COCOMO II and reference class over a bundled database | Actuals you record | Holdout script over your recorded estimates and actuals |

[METR's time horizons](https://metr.org/) answer a different question: what AI can do at a given reliability, as opposed to how long your build will take.

If you have no session history yet, the prompt-based tools can answer today. howlong will tell you it has nothing to go on.

## Install

Needs Node 22.13 or later. It is not on npm yet, so build from source:

```sh
git clone https://github.com/kd-011/howlong.git
cd howlong
npm install
npm run build
npm link
```

## Quickstart

To try it with no data of your own:

```sh
howlong demo
howlong backtest --source cortex:howlong-demo/cortex.db
```

### Claude Code

howlong reads the transcripts under `~/.claude/projects` by default. The first run on a large history can take a minute or so, and after that results are cached per file.

```sh
howlong sources --source claude
howlong backtest --source claude
howlong estimate "Add rate limiting to the API" --repo my-api --source claude
```

A new session starts at a prompt after 30 quiet minutes (`--idle` changes that). Active time leaves out those gaps and the time a person took to reply, so a job that waited overnight for you does not count as a long job.

### Cortex

The `cortex` source reads the SQLite database of the Cortex agent orchestrator. It opens the file read-only and does not block a running Cortex from writing.

```sh
howlong sources --source cortex:/path/to/cortex.db
howlong backtest --source cortex:/path/to/cortex.db
howlong estimate "Add rate limiting to the API" --repo my-api --source cortex:/path/to/cortex.db
```

Each session uses the best duration signal it has: turn start and finish times, then gaps between turns, then the row's own timestamps. That last one is flagged low confidence because archiving a session bumps them.

### Setting a default source

Set `HOWLONG_SOURCE=cortex:/path/to/cortex.db`, or put this in `~/.config/howlong/config.json`:

```json
{ "sources": ["cortex:/path/to/cortex.db", "claude"] }
```

Listing both reads both. If the two logs cover the same work, that work counts twice.

### Plans

Give it steps and dependencies, and optionally a limit on how many run at once:

```json
{
  "repo": "storefront",
  "steps": [
    { "id": "schema", "brief": "Migrate the database driver to the new major version" },
    { "id": "api", "brief": "Add csv export endpoint", "dependsOn": ["schema"] },
    { "id": "ui", "brief": "Add dark mode toggle to the settings form", "dependsOn": ["schema"] },
    { "id": "tests", "brief": "Fix flaky login test and cover the export", "dependsOn": ["api", "ui"] }
  ]
}
```

```
$ howlong plan howlong-demo/plan.json --concurrency 2 --source cortex:howlong-demo/cortex.db
Plan total, at most 2 at once:
  P50 2h 41m   P80 3h 50m   P95 5h 26m
One step at a time, for contrast:
  P50 3h 12m   P80 4h 32m   P95 6h 16m

step    P50     P80     P95     critical confidence
schema  1h 9m   1h 57m  3h 14m  100%     medium
api     31m     1h 2m   1h 20m  37%      medium
ui      46m     1h      1h 37m  63%      medium
tests   29m     55m     1h 28m  100%     high
```

`critical` is how often that step sat on the path that set the finish time.

### Recording what happened

`estimate` and `plan` save what they predicted and print an id. Tell howlong how it went:

```sh
howlong record 4f1c9a2e 45m
howlong record
```

Once 10 single estimates have actuals, they start correcting later estimates. The median shifts toward what you recorded and the range can widen, but recorded actuals never narrow it. Everything stays in `~/.local/share/howlong` (or `$XDG_DATA_HOME/howlong`, or `$HOWLONG_HOME`) and nothing leaves your machine.

## MCP server

```json
{
  "mcpServers": {
    "howlong": {
      "command": "howlong",
      "args": ["mcp", "--source", "claude"]
    }
  }
}
```

The tools are `estimate`, `estimate_plan`, `record_actual` and `backtest`. Their descriptions tell the agent to call them when asked how long something will take. Sources are set in this config and cannot be changed through tool arguments.

## How the estimate works

1. Load finished sessions. Failed and abandoned ones are left out, as are sessions under 30 seconds and sessions with no activity data that span more than 12 hours, which are almost always sessions left open.
2. Pick the narrowest class with at least 8 sessions: same repo and model, then same repo, then same model, then everything. The output says which one it used.
3. Score each session in the class by TF-IDF similarity to your brief, closeness in brief length and declared scope, and the quality of its duration signal. Keep the 60 highest.
4. Take weighted quantiles of their durations in log space, blended with a lognormal fit so a thin sample does not leave steps in the curve.
5. Widen the range according to the effective sample size. Below about 5 effective sessions a minimum spread applies, so even one past session gives a range.

Plans sample each step from its own distribution in a seeded Monte Carlo over a dependency-aware schedule. Steps are correlated at 0.3 by default (`--correlation`), because steps in one plan tend to overrun together and independent sampling makes totals look too certain. That 0.3 is a judgement call, and the backtest does not test it.

The forecast covers agent working time plus short pauses. Time spent waiting for a person to review or approve is not in it.

## Backtest

```
$ howlong backtest --source cortex:howlong-demo/cortex.db
Backtest: rolling origin (each forecast sees only earlier sessions)
297 forecasts scored from 327 usable sessions.

Calibration, share of actuals at or under each quantile:
  quantile  howlong  95% CI      plain median of all sessions
  P10       8%       6%-12%      18%
  P25       24%      19%-29%     34%
  P50       59%      53%-64%     57%
  P80       87%      83%-91%     81%
  P90       94%      91%-96%     88%
  P95       98%      96%-99%     92%

Median absolute % error of P50: 36% (plain median: 57%)
Median P95/P50 spread: 3.1x (plain median: 3.6x)

By reference class:
  repo+model  n=261   P80 coverage 87%   error 36%
  repo        n=31    P80 coverage 90%   error 44%
  model       n=5     P80 coverage 100%  error 22%

By confidence label:
  low         n=145   P80 coverage 87%   error 34%
  medium      n=145   P80 coverage 88%   error 39%
  high        n=7     P80 coverage 86%   error 22%

P80 runs cautious: 87% landed under it, so ranges are wider than they need to be.
Similarity beats a plain median of all sessions by 21 points of error.
```

This is invented data with a known structure, so it shows the report format and predicts nothing about your history. Run it on yours. If the verdict says the P80 is optimistic, or that similarity does not beat a plain median, believe it.

The default replay only lets each forecast see earlier sessions. `--method loo` holds out one session at a time and uses all the others, including later ones, which flatters the result slightly.

## Limits

- Expect wide ranges. Agent durations are noisy, and a median error of 30 to 50 percent is a realistic result.
- With no usable history, howlong exits with an error and gives no estimate.
- A brief unlike anything in your history falls back on sessions that are only loosely similar. The confidence label reflects sample size and spread, so it will not warn you that a job is novel.
- `--size` is your own judgement, matched against past token counts. The backtest cannot check it, because history does not record what someone would have guessed.
- Text similarity is keyword matching. "login" matches "login" and misses "auth".
- The Claude adapter cannot see outcomes, so failed work in those transcripts counts as finished.
- A quiet stretch in the middle of a job looks like idling, so a tool call running for over 30 minutes goes uncounted.

## Library

```ts
import { Estimator, backtest, loadSessions } from 'howlong';

const sessions = await loadSessions(['claude']);
const estimate = new Estimator(sessions).estimate({ brief: 'Add rate limiting', repo: 'my-api' });
const report = backtest(sessions);
```

To support another agent, implement `SessionSource`: a `name` and a `sessions()` async iterable of `Session` records.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run verify:mcp   # starts the built server over stdio and lists its tools
npm run fixtures     # writes the seeded synthetic history to ./fixtures
```

Tests and fixtures only use the seeded generator in `src/synthetic.ts`.

## License

MIT
