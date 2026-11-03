# discord-agent-pilot

A Discord bot that monitors and controls Claude Code running in tmux through Discord threads.

## Setup

```bash
pnpm install
cp config.example.yaml config.yaml   # edit the values for your environment
pnpm dev
```

The Discord token is read from `discordToken` in `config.yaml`, or from the `DISCORD_TOKEN` environment variable when it is omitted.

## CLAUDE_CONFIG_DIR support

When the `CLAUDE_CONFIG_DIR` environment variable is set, Claude Code stores its settings and conversation logs there instead of in `~/.claude`. discord-agent-pilot reads this value from `${claude.procRoot}/<pid>/environ` of the `claude` process found in each tmux pane, and switches to the matching JSONL search root per session (falling back to `claude.defaultConfigDir` when it is unset). When running in Docker, set `claude.procRoot` to `/host/proc` and bind-mount the host's `/proc` there; when running directly on the host, keep the default `/proc`.

- List the allowed `CLAUDE_CONFIG_DIR` values in `configDirs` of `config.yaml` as an array of `hostPath`/`containerPath` pairs. `claude.defaultConfigDir` is always implicitly allowed.
- `hostPath` is compared as a string with the raw host-side value read from `${claude.procRoot}/<pid>/environ`, so `~` is not expanded. Use an absolute path.
- Sessions whose `CLAUDE_CONFIG_DIR` is not listed in `configDirs` (or `defaultConfigDir`) are rejected and no Discord thread is created.
- When running in Docker, each `hostPath` must be bind-mounted read-only to its `containerPath` (see `compose.yaml`). To allow additional `CLAUDE_CONFIG_DIR` values, add an entry to `configDirs` and the matching bind mount.

## Architecture

`src/` is split by responsibility:

```
src/
  config/      config loading and validation (zod)
  registry/    SQLite session registry and input queue (better-sqlite3)
  discord/     ParentChannel (text/forum) abstraction, permissions, discord.js client
  tmux/        tmux session listing, process tree inspection, sessionId resolution, input sending
  claude-log/  Claude Code JSONL log tail / parse / format
  core/        orchestrator (periodic polling) and workers tying the above together
```
