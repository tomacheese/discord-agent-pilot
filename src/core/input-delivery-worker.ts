import type Database from 'better-sqlite3'
import {
  findOldestPendingInput,
  updateInputQueueState,
} from '../registry/input-queue'
import { findSessionById } from '../registry/sessions'
import { sendTextToPane } from '../tmux/send'
import type { ExecFunction } from '../tmux/list-sessions'

/** External dependencies `triggerInputDelivery` needs, injected for testability. */
export interface InputDeliveryDependencies {
  db: Database.Database
  exec: ExecFunction
  socketPath: string
}

/** Per-`InputDeliveryDependencies` set of sessionIds currently being delivered. */
const inProgressBySessionByDependencies = new WeakMap<
  InputDeliveryDependencies,
  Set<string>
>()

/** Returns the in-progress `Set` for `dependencies`, creating an empty one on first use. */
function getInProgressSet(
  dependencies: InputDeliveryDependencies
): Set<string> {
  let set = inProgressBySessionByDependencies.get(dependencies)
  if (!set) {
    set = new Set()
    inProgressBySessionByDependencies.set(dependencies, set)
  }
  return set
}

/** Generates a tmux buffer name unique to this row, avoiding cross-session buffer races (see `sendTextToPane`). */
function makeBufferName(sessionId: string, inputQueueRowId: number): string {
  return `dap-${sessionId}-${inputQueueRowId}`
}

/**
 * Delivers one pending row for `sessionId`: resolves the session's
 * `tmuxPaneId`, sends the row's body via `sendTextToPane`, and updates the
 * row's state to `sent` or `failed`. Never throws — all failures are
 * recorded as `state = 'failed'` on the row itself so the caller's loop can
 * continue to the next row.
 */
async function deliverOne(
  dependencies: InputDeliveryDependencies,
  sessionId: string,
  row: { id: number; body: string }
): Promise<void> {
  const session = findSessionById(dependencies.db, sessionId)
  if (!session || session.tmuxPaneId === '') {
    console.error(
      `No resolvable tmux pane for session ${sessionId}; marking input_queue row ${row.id} as failed`
    )
    updateInputQueueState(dependencies.db, row.id, 'failed')
    return
  }

  updateInputQueueState(dependencies.db, row.id, 'sending')
  try {
    await sendTextToPane(
      dependencies.exec,
      dependencies.socketPath,
      session.tmuxPaneId,
      makeBufferName(sessionId, row.id),
      row.body
    )
    updateInputQueueState(dependencies.db, row.id, 'sent')
  } catch (error) {
    console.error(
      `Failed to deliver input_queue row ${row.id} for session ${sessionId}; marking failed:`,
      error
    )
    updateInputQueueState(dependencies.db, row.id, 'failed')
  }
}

/**
 * Delivers every currently-`pending` `input_queue` row for `sessionId`, in
 * FIFO order, until none remain. Re-queries `findOldestPendingInput` after
 * each row rather than snapshotting the list up front, so a row inserted
 * while this loop is running is also picked up without a second trigger.
 *
 * If a delivery loop for `sessionId` is already running (tracked via
 * `getInProgressSet`), this call is a no-op — the running loop's re-query
 * behavior already guarantees the newly-pending row will be picked up.
 *
 * Fire-and-forget: does not return a Promise the caller awaits, since
 * callers (the Discord message handler, the startup sweep) trigger
 * delivery without blocking on it.
 */
export function triggerInputDelivery(
  dependencies: InputDeliveryDependencies,
  sessionId: string
): void {
  const inProgress = getInProgressSet(dependencies)
  if (inProgress.has(sessionId)) return
  inProgress.add(sessionId)

  const loop = async (): Promise<void> => {
    for (;;) {
      const row = findOldestPendingInput(dependencies.db, sessionId)
      if (!row) return
      await deliverOne(dependencies, sessionId, row)
    }
  }

  // eslint-disable-next-line no-void
  void loop().finally(() => {
    inProgress.delete(sessionId)
  })
}
