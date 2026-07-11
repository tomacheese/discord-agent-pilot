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

## アーキテクチャ

`src/` は責務ごとにディレクトリ分割されている。エントリポイントは `src/index.ts`。

```
src/
  config/      設定ファイルの読込・zod バリデーション
  registry/    SQLite の session registry / input queue、手書きマイグレーション(migrations/NNN_*.sql)
  discord/     discord.js クライアント、ParentChannel(text/forum)抽象、権限制御、添付処理
  tmux/        tmux セッション列挙・プロセスツリー検査・sessionId 解決・入力送信
  claude-log/  Claude Code JSONL ログの tail / parse / format
  core/        orchestrator と各ワーカー(log-sync / input-delivery / allowed-message)
  test-utils/  テスト補助
```

## セキュリティ / 運用

- `config.yaml`・`.env`・`*.db` は `.gitignore` 済み。Discord トークン等の秘密情報を含むため絶対にコミットしない。
- Discord からの操作は `config.yaml` の `allowedUserIds` でホワイトリスト制御される。権限チェックを緩めない。
- `CLAUDE_CONFIG_DIR` は `configDirs` / `claude.defaultConfigDir` に列挙されたもののみ許可する(挙動の詳細は README を参照)。
