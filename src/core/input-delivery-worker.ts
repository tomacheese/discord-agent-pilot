import type Database from 'better-sqlite3'
import {
  findOldestPendingInput,
  updateInputQueueState,
} from '../registry/input-queue'
import { findSessionById, hasTmuxPane } from '../registry/sessions'
import { sendTextToPane } from '../tmux/send'
import type { ExecFunction } from '../tmux/list-sessions'
import { isSessionProcessAlive } from './session-liveness'

/** External dependencies `triggerInputDelivery` needs, injected for testability. */
export interface InputDeliveryDependencies {
  db: Database.Database
  exec: ExecFunction
  socketPath: string
  /** `/proc` root used to verify the Claude process a session is bound to before pasting into its pane. */
  procRoot: string
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
 * Delivers one pending row for `sessionId`: re-reads the session and refuses
 * to paste unless it is still open, has a tmux pane, and the Claude process
 * it is bound to is still running (a session can close, or its pane can be
 * taken over by another process, between queuing and delivery, or while a
 * drain loop is running). Otherwise sends the row's body via
 * `sendTextToPane` and updates the row's state to `sent` or `failed`.
 * Never throws — all failures (including a rejected target, or an error
 * while writing the `sending` state) are recorded as `state = 'failed'` on
 * the row itself so the caller's loop can continue to the next row.
 */
async function deliverOne(
  dependencies: InputDeliveryDependencies,
  sessionId: string,
  row: { id: number; body: string }
): Promise<void> {
  const reject = (reason: string): void => {
    console.error(`${reason}; marking input_queue row ${row.id} as failed`)
    updateInputQueueState(dependencies.db, row.id, 'failed')
  }

  try {
    const session = findSessionById(dependencies.db, sessionId)
    if (!session) {
      reject(`Session ${sessionId} not found`)
      return
    }
    if (session.status === 'closed') {
      reject(`Session ${sessionId} is closed`)
      return
    }
    if (!hasTmuxPane(session)) {
      reject(`No resolvable tmux pane for session ${sessionId}`)
      return
    }
    if (!(await isSessionProcessAlive(dependencies.procRoot, session))) {
      reject(`Claude process bound to session ${sessionId} is not running`)
      return
    }

    updateInputQueueState(dependencies.db, row.id, 'sending')
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
