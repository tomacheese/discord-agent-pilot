# discord-agent-pilot

Discord スレッドを通じて、tmux 上で動作する Claude Code を監視・操作できる Discord Bot。

## セットアップ

```bash
pnpm install
cp config.example.yaml config.yaml   # 値を環境に合わせて編集する
pnpm dev
```

## CLAUDE_CONFIG_DIR 対応

Claude Code は `CLAUDE_CONFIG_DIR` 環境変数が設定されている場合、`~/.claude` の代わりにそのディレクトリを設定・会話ログの置き場所として使う。discord-agent-pilot は、検出した tmux ペイン内の `claude` プロセスの `${claude.procRoot}/<pid>/environ`(Docker コンテナ実行時は `claude.procRoot` を `/host/proc` に設定してホストの `/proc` を bind mount 経由で参照する。ホスト直接実行時は既定値の `/proc` のまま)からこの値を読み取り、セッションごとに正しい JSONL 探索ルートへ切り替える(未設定時は `claude.defaultConfigDir` にフォールバックする)。

- 許可する `CLAUDE_CONFIG_DIR` は `config.yaml` の `configDirs`(`hostPath`/`containerPath` のペアの配列)で列挙する。`claude.defaultConfigDir` は常に暗黙的に許可される。
- `hostPath` は `${claude.procRoot}/<pid>/environ` から取得したホスト側の生の値と文字列比較されるため、`~` は展開されない。絶対パスで指定すること。
- `configDirs`(および `defaultConfigDir`)に列挙されていない `CLAUDE_CONFIG_DIR` を持つセッションは拒否され、Discord スレッドは作成されない。
- Docker コンテナ実行時は、`hostPath` ごとに対応する `containerPath` へホスト側ディレクトリを読み取り専用で bind mount する必要がある(`compose.yaml` 参照)。複数の `CLAUDE_CONFIG_DIR` を許可する場合は、`configDirs` にエントリを追加すると同時に、対応する bind mount も追加する。

## アーキテクチャ

`src/` は責務ごとにディレクトリ分割されている。

```
src/
  config/     設定ファイルの読込・バリデーション(zod)
  registry/   SQLiteによるsession registry(better-sqlite3)
  discord/    ParentChannel(text/forum)抽象、権限制御、discord.jsクライアント
  tmux/       tmuxセッション列挙・プロセスツリー検査・sessionId解決
  core/       上記を束ねるorchestrator(定期ポーリング)
```
