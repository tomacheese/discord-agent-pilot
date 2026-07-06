# discord-agent-pilot

Discord スレッドを通じて tmux 上の Claude Code を監視・操作する Discord Bot。

## Tech Stack

- Runtime: Node.js 24 + TypeScript(ES2024, bundler resolution)
- Discord: discord.js 14
- DB: SQLite(`better-sqlite3`)、手書きマイグレーション(`registry/migrations/NNN_*.sql`)
- 設定: zod によるバリデーション、YAML(`yaml`パッケージ)
- テスト: Vitest(+ 結合テストに fauxcord)
- Lint: ESLint(`@book000/eslint-config`) + Prettier
- パッケージマネージャ: pnpm

## コマンド

```bash
pnpm dev      # tsx watch で起動(ホットリロード)
pnpm test     # Vitest 実行
pnpm lint     # tsc + eslint + prettier
pnpm fix      # eslint --fix + prettier --write
pnpm start    # 本番起動(tsx直接実行、コンパイルなし)
```

## コーディング規約

- コードコメント・jsdoc・エラーメッセージは英語。
- `any` 型は使用しない。
- テストファイルはソースと同階層に `*.test.ts` として置く。
