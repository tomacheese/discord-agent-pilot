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
  /**
   * tmux's own pane identifier (e.g. `%12`), unique across the whole tmux
   * server. Unlike `tmuxSession` (a session may have multiple panes) or
   * `tmuxPanePid` (a process PID, not usable as a tmux `-t` target), this is
   * the value used to target `set-buffer`/`paste-buffer`/`send-keys` at
   * this session's exact pane. Empty string for rows registered before this
   * column existed (pre-release data; not backfilled).
   */
  tmuxPaneId: string
  /**
   * PID of the Claude Code process this row is bound to. Together with
   * `claudeStartTicks` it identifies one process instance, so a reused PID is
   * not mistaken for the original process. Empty string for rows registered
   * before this column existed (identity unknown; judged by a pane-level
   * process lookup until the next resolution of the pane adopts an identity).
   */
  claudePid: string
  /** Start time (clock ticks since boot) of the process identified by `claudePid`. */
  claudeStartTicks: number
  cwd: string
  configDir: string
  jsonlPath: string
  jsonlOffset: number
  status: string
  threadNameSource: ThreadNameSource
  /** Short human-readable summary of the session's most recent action, derived from JSONL entries. Empty string until the first assistant/user entry is processed. */
  lastActionSummary: string
  createdAt: number
  updatedAt: number
}

/** The tmux pane and Claude process a session row is (re)bound to. */
export interface SessionBinding {
  tmuxSession: string
  tmuxPanePid: string
  tmuxPaneId: string
  claudePid: string
  claudeStartTicks: number
}

const SESSION_COLUMNS = `id, thread_id AS threadId,
              parent_channel_id AS parentChannelId,
              tmux_session AS tmuxSession, tmux_pane_pid AS tmuxPanePid,
              tmux_pane_id AS tmuxPaneId,
              claude_pid AS claudePid,
              claude_start_ticks AS claudeStartTicks,
              cwd, config_dir AS configDir, jsonl_path AS jsonlPath,
              jsonl_offset AS jsonlOffset, status,
              thread_name_source AS threadNameSource,
              last_action_summary AS lastActionSummary,
              created_at AS createdAt, updated_at AS updatedAt`

/**
 * Returns whether `session` has a resolved tmux pane id, i.e. `tmuxPaneId`
 * is not the empty-string sentinel documented on `SessionRow.tmuxPaneId`.
 */
export function hasTmuxPane(session: SessionRow): boolean {
  return session.tmuxPaneId !== ''
}

/**
 * Returns the session row for `id` (the Claude Code sessionId), or undefined if not registered.
 */
export function findSessionById(
  db: Database.Database,
  id: string
): SessionRow | undefined {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined
}

/**
 * Returns the session row whose `threadId` matches `threadId`, or undefined
 * if no session is registered for that Discord thread. Used to resolve a
 * Discord message's channel/thread back to the session it belongs to.
 */
export function findSessionByThreadId(
  db: Database.Database,
  threadId: string
): SessionRow | undefined {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE thread_id = ?`)
    .get(threadId) as SessionRow | undefined
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
       (id, thread_id, parent_channel_id, tmux_session, tmux_pane_pid,
        tmux_pane_id, claude_pid, claude_start_ticks, cwd, config_dir,
        jsonl_path, jsonl_offset, status, thread_name_source,
        last_action_summary, created_at, updated_at)
     VALUES
       (@id, @threadId, @parentChannelId, @tmuxSession, @tmuxPanePid,
        @tmuxPaneId, @claudePid, @claudeStartTicks, @cwd, @configDir,
        @jsonlPath, @jsonlOffset, @status, @threadNameSource,
        @lastActionSummary, @createdAt, @updatedAt)`
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

/** Updates `last_action_summary` for `sessionId`. No-op if `sessionId` does not exist. */
export function updateLastActionSummary(
  db: Database.Database,
  sessionId: string,
  summary: string
): void {
  db.prepare('UPDATE sessions SET last_action_summary = ? WHERE id = ?').run(
    summary,
    sessionId
  )
}

/**
 * Updates `jsonl_path` and `jsonl_offset` for `sessionId`.
 *
 * Used when a session's Claude Code process starts writing to a new JSONL
 * file — e.g. when its cwd switches into a git worktree, or switches back
 * from one — so the DB row (and the caller's in-memory session/tailer
 * state) tracks the file the process is actually writing to right now.
 *
 * `jsonlOffset` is always supplied by the caller rather than hardcoded to
 * `0`: a freshly-entered worktree's JSONL file starts out empty, so `0` is
 * correct there, but switching back to a pre-existing file that already has
 * content requires seeding the offset from that file's current state.
 * Otherwise the tailer would start reading from the beginning of the file
 * and re-post its already-synced historical content to Discord as if it
 * were new — the duplicate-reposting bug identified in Issue #25's review.
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

/**
 * Returns every session row whose `status` is not `'closed'`.
 */
export function findOpenSessions(db: Database.Database): SessionRow[] {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE status != 'closed'`)
    .all() as SessionRow[]
}

/**
 * Returns the open (not `'closed'`) session rows bound to tmux pane
 * `paneId`. An empty `paneId` is the legacy "unknown pane" sentinel and
 * matches nothing.
 */
export function findOpenSessionsByPaneId(
  db: Database.Database,
  paneId: string
): SessionRow[] {
  if (paneId === '') return []
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE status != 'closed' AND tmux_pane_id = ?`
    )
    .all(paneId) as SessionRow[]
}

/**
 * Reopens `sessionId` (status `'discovered'`) and binds it to `binding`'s
 * tmux pane and Claude process. Leaves the Discord thread, JSONL path and
 * offset, cwd and config dir untouched so a resumed session keeps its
 * thread and does not re-post already-synced log content.
 */
export function rebindSession(
  db: Database.Database,
  sessionId: string,
  binding: SessionBinding
): void {
  db.prepare(
    `UPDATE sessions
     SET tmux_session = @tmuxSession, tmux_pane_pid = @tmuxPanePid,
         tmux_pane_id = @tmuxPaneId, claude_pid = @claudePid,
         claude_start_ticks = @claudeStartTicks, status = 'discovered',
         updated_at = @updatedAt
     WHERE id = @sessionId`
  ).run({ ...binding, sessionId, updatedAt: Date.now() })
}

/** Marks `sessionId`'s `status` as `'closed'`. */
export function markSessionClosed(
  db: Database.Database,
  sessionId: string
): void {
  db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(
    sessionId
  )
}
