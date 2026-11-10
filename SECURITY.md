# Security

howlong reads your finished coding-agent sessions and does statistics over them. It makes no network requests and runs no other programs.

## What it touches

- Reads Claude Code transcripts under `~/.claude/projects` and any Cortex SQLite databases you point it at. SQLite databases are opened read-only.
- Writes its own estimate store and a transcript parse cache under `$XDG_DATA_HOME/howlong` (default `~/.local/share/howlong`), created with mode 0600. Nothing else is written.
- Session titles and repo names from your transcripts appear in its output and in the store. Treat the store as you treat the transcripts.
- The MCP server exposes `estimate`, `estimate_plan`, `backtest` and `record_actual`. Only `record_actual` writes, and only to the store above.

## Reporting a problem

If you find a way to make howlong read outside the sources above, write anywhere but its own data directory, make a network request, run a command, or hang or crash on a crafted transcript, use GitHub's private vulnerability reporting on this repository (the Security tab), not a public issue.

A wrong estimate is not a security problem. Open an issue with the backtest output.
