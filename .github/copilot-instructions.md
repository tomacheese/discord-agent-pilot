# Copilot code review instructions

discord-agent-pilot は、tmux 上で動作する Claude Code を Discord スレッド経由で監視・操作する Discord Bot(Node.js 24 + TypeScript, discord.js 14, better-sqlite3, pnpm)。以下はプルリクエストのコードレビュー時に重視してほしい観点。

## 重点的に確認する点

- **セキュリティ境界を緩めていないか**:
  - Discord からの操作は `config.yaml` の `allowedUserIds` によるホワイトリストで制御される。権限チェック(`src/discord/permissions.ts`)を迂回・無効化する変更は指摘する。
  - `CLAUDE_CONFIG_DIR` は `configDirs` / `claude.defaultConfigDir` に列挙された値のみ許可する設計。許可リストの検証を弱める変更や、未検証のパスを JSONL 探索・bind mount に流す変更は指摘する。
  - トークン・秘密情報のハードコードや、ログへの秘密情報出力がないか。
- **ワーカー / ポーリングループのエラー分離**: orchestrator と各ワーカー(`src/core/` の log-sync / input-delivery / allowed-message)は定期実行される。単一セッションやメッセージの処理失敗が、ループ全体や他セッションの処理を恒久的に停止させないか(過去に長大な入力で Discord 送信が失敗しログ同期が全停止した不具合あり)。例外が握りつぶされて無言で処理が止まらないかも確認する。
- **SQLite マイグレーション**: `src/registry/migrations/NNN_*.sql` は追記式・連番。既存マイグレーションファイルの改変ではなく新規番号での追加になっているか。
- **テスト**: ロジック追加・変更に対応するテスト(`*.test.ts`)があるか。

## このプロジェクトの規約(違反は指摘)

- コードコメント・jsdoc・エラーメッセージは英語。
- `any` 型は使用しない。
- テストファイルはソースと同階層に `*.test.ts` として置く。
- Prettier 設定: セミコロンなし(`semi: false`)、シングルクォート、`trailingComma: es5`、`printWidth: 80`。フォーマットは Prettier に委ねる。

## フラグすべきでない既知パターン(誤検知防止)

- **セミコロン欠如**: Prettier が `semi: false` を強制しているため、文末セミコロンが無いのは正しい。欠落として指摘しない。
- **`db` という短縮名**: SQLite ハンドルの慣用名として意図的に許可されている(`eslint.config.mjs` で `unicorn/name-replacements` の `db` のみ無効化)。省略形として指摘しない。
- **`fauxcord` が未使用に見える devDependency**: `src/integration.test.ts` からリテラルパス(`node_modules/fauxcord/...`)で spawn しているため静的解析では未使用に見えるが、実際に使用されている。CI でも depcheck はこの理由で無効化済み。
