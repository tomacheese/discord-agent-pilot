import type Database from 'better-sqlite3'

/** The origin of a session's currently-applied Discord thread name. */
export type ThreadNameSource = 'fallback' | 'ai-title' | 'agent-name'

/**
 * A row in the `sessions` table.
 */
export interface SessionRow {
  id: string
  threadId: string
  parentChannelId: string
  tmuxSession: string
  tmuxPanePid: string
  cwd: string
  configDir: string
  jsonlPath: string
  jsonlOffset: number
  status: string
  threadNameSource: ThreadNameSource
  createdAt: number
  updatedAt: number
}

/**
 * Returns the session row for `id` (the Claude Code sessionId), or undefined if not registered.
 */
export function findSessionById(
  db: Database.Database,
  id: string
): SessionRow | undefined {
  return db
    .prepare(
      `SELECT id, thread_id AS threadId, parent_channel_id AS parentChannelId,
              tmux_session AS tmuxSession, tmux_pane_pid AS tmuxPanePid,
              cwd, config_dir AS configDir, jsonl_path AS jsonlPath,
              jsonl_offset AS jsonlOffset, status,
              thread_name_source AS threadNameSource,
              created_at AS createdAt, updated_at AS updatedAt
       FROM sessions WHERE id = ?`
    )
    .get(id) as SessionRow | undefined
}

/**
 * Inserts a new session row. Throws if a row with the same `id` already exists.
 */
export function insertSession(
  db: Database.Database,
  session: SessionRow
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, thread_id, parent_channel_id, tmux_session, tmux_pane_pid, cwd,
        config_dir, jsonl_path, jsonl_offset, status, thread_name_source,
        created_at, updated_at)
     VALUES
       (@id, @threadId, @parentChannelId, @tmuxSession, @tmuxPanePid, @cwd,
        @configDir, @jsonlPath, @jsonlOffset, @status, @threadNameSource,
        @createdAt, @updatedAt)`
  ).run(session)
}

/** Updates `thread_name_source` for `sessionId`. */
export function updateThreadNameSource(
  db: Database.Database,
  sessionId: string,
  source: ThreadNameSource
): void {
  db.prepare('UPDATE sessions SET thread_name_source = ? WHERE id = ?').run(
    source,
    sessionId
  )
}

/**
 * `sessionId` の `jsonl_path` と `jsonl_offset` を更新する。
 * セッションの Claude Code プロセスが新しい JSONL ファイルへの書き込みを
 * 開始したとき(例: git worktree への cwd 切り替え時、およびそこから元の
 * cwd へ戻ったとき)に使用する。`jsonlOffset` は常に `0` ではなく呼び出し元が
 * 指定する — 新規 worktree に入った直後のファイルは空なのでオフセット `0` で
 * 問題ないが、既存の(内容が入った)ファイルに戻る場合はそのファイルの現在の
 * バイトサイズをオフセットとして与える必要がある。そうしないと tailer が
 * ファイル先頭から再読込し、既に Discord へ投稿済みの過去の内容を新規分として
 * 重複投稿してしまう(Issue #25 のレビュー指摘)。
 */
export function updateJsonlPath(
  db: Database.Database,
  sessionId: string,
  jsonlPath: string,
  jsonlOffset: number
): void {
  db.prepare(
    'UPDATE sessions SET jsonl_path = ?, jsonl_offset = ? WHERE id = ?'
  ).run(jsonlPath, jsonlOffset, sessionId)
}

/**
 * Reads the current `thread_name_source` for `sessionId`.
 * @throws {Error} If no session row exists for `sessionId`.
 */
export function getThreadNameSource(
  db: Database.Database,
  sessionId: string
): ThreadNameSource {
  const row = db
    .prepare(
      'SELECT thread_name_source AS threadNameSource FROM sessions WHERE id = ?'
    )
    .get(sessionId) as { threadNameSource: ThreadNameSource } | undefined
  if (!row) {
    throw new Error(`No session found for id: ${sessionId}`)
  }
  return row.threadNameSource
}
