import type Database from 'better-sqlite3'

/** The lifecycle states of an `input_queue` row. */
export type InputQueueState = 'pending' | 'sending' | 'sent' | 'failed'

/** An `input_queue` row in `state = 'pending'`, as read for delivery. */
export interface PendingInputRow {
  id: number
  body: string
}

/**
 * Inserts a new `input_queue` row in `pending` state and returns the id of
 * the inserted row (used by the caller to update its state later).
 */
export function insertPendingInput(
  db: Database.Database,
  sessionId: string,
  source: string,
  body: string
): number {
  const result = db
    .prepare(
      `INSERT INTO input_queue (session_id, source, body, state, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    )
    .run(sessionId, source, body, Date.now())
  return Number(result.lastInsertRowid)
}

/**
 * Returns the oldest (lowest id, i.e. first-inserted) `pending` row for
 * `sessionId`, or undefined if none exists. Used by the delivery worker to
 * process rows in FIFO order.
 */
export function findOldestPendingInput(
  db: Database.Database,
  sessionId: string
): PendingInputRow | undefined {
  return db
    .prepare(
      `SELECT id, body FROM input_queue
       WHERE session_id = ? AND state = 'pending'
       ORDER BY id ASC
       LIMIT 1`
    )
    .get(sessionId) as PendingInputRow | undefined
}

/** Updates the `state` of the `input_queue` row identified by `id`. */
export function updateInputQueueState(
  db: Database.Database,
  id: number,
  state: InputQueueState
): void {
  db.prepare('UPDATE input_queue SET state = ? WHERE id = ?').run(state, id)
}

/**
 * Crash recovery: moves every row still in `state = 'sending'` to `failed`.
 * A row can be left in `sending` if the process crashed or was killed
 * mid-delivery; whether the tmux command actually reached the pane before
 * the crash is unknown, so this resolves the ambiguity to the safe side
 * (`failed`, requiring manual resend) rather than silently retrying and
 * risking a duplicate submission.
 */
export function resetStaleSendingInputs(db: Database.Database): void {
  db.prepare(
    "UPDATE input_queue SET state = 'failed' WHERE state = 'sending'"
  ).run()
}

/**
 * Returns the distinct `session_id`s that have at least one `pending` row.
 * Used at startup to re-trigger delivery for any input queued before a
 * restart, since delivery is otherwise only triggered on message arrival.
 */
export function findSessionIdsWithPendingInput(
  db: Database.Database
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT session_id AS sessionId FROM input_queue WHERE state = 'pending'`
    )
    .all() as { sessionId: string }[]
  return rows.map((row) => row.sessionId)
}
