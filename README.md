# discord-agent-pilot

Discord スレッドを通じて、tmux 上で動作する Claude Code を監視・操作できる Discord Bot。

## セットアップ

```bash
pnpm install
cp config.example.yaml config.yaml   # 値を環境に合わせて編集する
pnpm dev
```

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
