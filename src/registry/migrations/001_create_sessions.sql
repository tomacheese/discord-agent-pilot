CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL,
  parent_channel_id TEXT NOT NULL,
  tmux_session      TEXT NOT NULL,
  tmux_pane_pid     TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  config_dir        TEXT NOT NULL,
  jsonl_path        TEXT NOT NULL,
  jsonl_offset      INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
