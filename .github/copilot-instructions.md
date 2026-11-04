# Copilot code review instructions

See [AGENTS.md](../AGENTS.md) for the project overview, language rule, conventions and safety rules. Review focus points:

- **Security boundaries**: flag changes that bypass or weaken the `allowedUserIds` check (`src/discord/permissions.ts`), the `CLAUDE_CONFIG_DIR` allow-list (`configDirs` / `claude.defaultConfigDir`), or that hardcode or log secrets.
- **Worker/polling error isolation**: a failure in one session or message must not permanently stop the `src/core/` loops or other sessions, and exceptions must not be silently swallowed.
- **SQLite migrations**: `src/registry/migrations/NNN_*.sql` are append-only and sequentially numbered; flag edits to existing files.
- **Tests**: logic changes should come with `*.test.ts` coverage.
- **Conventions**: no `any`, English comments/JSDoc/docstrings and English error messages (thrown or logged; only end-user-facing Discord text may be Japanese), tests next to the source, Prettier formatting left to Prettier.

## Known patterns not to flag

- Missing semicolons (Prettier `semi: false`).
- The short name `db` for the SQLite handle (intentionally allowed in `eslint.config.mjs`).
- `fauxcord` appearing unused: `src/integration.test.ts` spawns it by literal path, and the depcheck CI job is disabled for this reason.
