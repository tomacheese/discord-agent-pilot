import type Database from 'better-sqlite3'

/**
 * A row in the `sessions` table (§5).
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
        config_dir, jsonl_path, jsonl_offset, status, created_at, updated_at)
     VALUES
       (@id, @threadId, @parentChannelId, @tmuxSession, @tmuxPanePid, @cwd,
        @configDir, @jsonlPath, @jsonlOffset, @status, @createdAt, @updatedAt)`
  ).run(session)
}
