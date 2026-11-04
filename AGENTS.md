# discord-agent-pilot

A Discord bot that monitors and controls Claude Code running in tmux through Discord threads.

## Language

- Commit descriptions, PR/Issue titles and bodies, code comments, JSDoc/docstrings, error messages (thrown or logged) and documents are written in English.
- Exceptions: end-user-facing Discord notification/UI text shown to users (e.g. the Japanese thread status text; this does not cover thrown/logged error messages, which stay English), Japanese data patterns and test fixtures, quotations, technical identifiers, and the Japanese fork-PR approval comment text in `.github/workflows/docker.yml` together with its `body-includes` match key (they must match each other).
- `package.json` is always English.

## Tech stack

- Node.js 24 + TypeScript (ES2024, bundler resolution), pnpm
- discord.js 14
- SQLite (`better-sqlite3`) with hand-written migrations (`src/registry/migrations/NNN_*.sql`)
- Config: YAML (`yaml`) validated with zod
- Tests: Vitest (integration test uses `fauxcord`)
- Lint: ESLint (`@book000/eslint-config`) + Prettier (no semicolons, single quotes, `trailingComma: es5`, `printWidth: 80`)

## Commands

```bash
pnpm dev      # tsx watch with hot reload
pnpm start    # run via tsx (no compile step)
pnpm test     # vitest run
pnpm lint     # tsc --noEmit + eslint + prettier --check
pnpm fix      # eslint --fix + prettier --write
```

Runtime paths come from `CONFIG_PATH` (default `./config.yaml`) and `DB_PATH` (default `./data/registry.db`). The token comes from `discordToken` in the config, or `DISCORD_TOKEN` if unset.

## Architecture

The entry point is `src/index.ts`. `src/` is split by responsibility:

```
src/
  config/      config loading and zod validation
  registry/    SQLite session registry and input queue, migrations
  discord/     discord.js client, ParentChannel (text/forum) abstraction, permissions, attachments
  tmux/        tmux session listing, process tree inspection, sessionId resolution, input sending
  claude-log/  Claude Code JSONL log tail / parse / format
  core/        orchestrator and workers (log-sync / input-delivery / allowed-message)
  test-utils/  test helpers
```

## Conventions

- Do not use `any`.
- Place tests next to the source as `*.test.ts`.
- `db` is an allowed short name for the SQLite handle (`unicorn/name-replacements` is disabled for `db` only).
- `fauxcord` looks unused statically because `src/integration.test.ts` spawns it by literal path; the depcheck CI job is disabled for this reason.

## Safety rules

- Never commit `config.yaml`, `.env` or `*.db` (they hold the Discord token and are git-ignored).
- Discord operations are restricted to `allowedUserIds` in `config.yaml` (`src/discord/permissions.ts`). Do not loosen or bypass this check.
- `CLAUDE_CONFIG_DIR` is only honored when listed in `configDirs` or `claude.defaultConfigDir`. Sessions with an unlisted value are rejected and no thread is created. Do not pass unvalidated paths to JSONL discovery or bind mounts. See README for details.
- Existing migration files are append-only: add a new numbered file instead of editing one.
- Orchestrator/worker loops in `src/core/` run periodically. A failure in one session or message must not stall the whole loop or other sessions (a past oversized input once broke Discord sending and halted all log sync), and errors must not be swallowed silently.
