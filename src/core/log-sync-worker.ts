import type Database from 'better-sqlite3'
import { parseJsonlLine } from '../claude-log/parse'
import {
  formatAssistantEntry,
  formatUserEntry,
  type PostItem,
} from '../claude-log/format'
import { createJsonlTailer, type JsonlTailer } from '../claude-log/tail'

/** A single Discord post: plain text and/or file attachments. At least one of `content`/`files` must be set. */
export interface SendInput {
  content?: string
  files?: { name: string; data: string | Buffer }[]
}

/** The subset of a Discord thread's API this worker needs. */
export interface DiscordThread {
  send: (input: SendInput) => Promise<unknown>
  sendTyping: () => Promise<void>
}

export interface LogSyncDependencies {
  db: Database.Database
  getThread: (threadId: string) => Promise<DiscordThread | undefined>
  /** Interval, in milliseconds, at which the caller (index.ts) re-invokes runLogSyncCycle. */
  pollIntervalMs: number
}

interface SessionRowForSync {
  id: string
  threadId: string
  jsonlPath: string
  jsonlOffset: number
}

interface PendingInputQueueRow {
  id: number
  body: string
}

function findActiveSessions(db: Database.Database): SessionRowForSync[] {
  return db
    .prepare(
      `SELECT id, thread_id AS threadId, jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset
       FROM sessions WHERE status != 'closed'`
    )
    .all() as SessionRowForSync[]
}

function updateJsonlOffset(
  db: Database.Database,
  sessionId: string,
  offset: number
): void {
  db.prepare('UPDATE sessions SET jsonl_offset = ? WHERE id = ?').run(
    offset,
    sessionId
  )
}

/** Reads the currently persisted `jsonl_offset` for `sessionId` from the DB. */
function getJsonlOffset(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare('SELECT jsonl_offset AS jsonlOffset FROM sessions WHERE id = ?')
    .get(sessionId) as { jsonlOffset: number } | undefined
  return row?.jsonlOffset ?? 0
}

function findUnconsumedSentInput(
  db: Database.Database,
  sessionId: string
): PendingInputQueueRow[] {
  return db
    .prepare(
      `SELECT id, body FROM input_queue WHERE session_id = ? AND state = 'sent'`
    )
    .all(sessionId) as PendingInputQueueRow[]
}

/**
 * Builds an `isEcho` matcher for `formatUserEntry`, backed by an in-memory
 * set of already-consumed `input_queue` row IDs. The set is process-local
 * and safe to lose on restart: after a restart, tailing resumes from
 * `jsonl_offset`, so the same `user` entry is re-evaluated against
 * `input_queue` rows that are still in `state = 'sent'` and matches again.
 *
 * Matches are NOT written into `consumedIds` directly — they are collected
 * into `pendingConsumedIds` instead, so that a match made while formatting
 * one content block of a `user` entry does not get treated as permanently
 * consumed until the *entire line* has been posted successfully (see
 * `processLine`). This keeps `isEcho` deterministic across retries: if a
 * later block in the same line throws and the line is retried, the same
 * text is evaluated against the same still-unconsumed `input_queue` rows
 * and produces the same match, instead of silently posting the
 * previously-suppressed echo as a duplicate.
 */
function makeEchoMatcher(
  db: Database.Database,
  sessionId: string,
  consumedIds: Set<string>,
  pendingConsumedIds: string[]
): (text: string) => boolean {
  return (text: string): boolean => {
    const candidates = findUnconsumedSentInput(db, sessionId)
    const isAlreadyClaimed = (id: number): boolean => {
      const key = `${sessionId}:${id}`
      return consumedIds.has(key) || pendingConsumedIds.includes(key)
    }
    const match = candidates.find(
      (row) => row.body === text && !isAlreadyClaimed(row.id)
    )
    if (!match) return false
    pendingConsumedIds.push(`${sessionId}:${match.id}`)
    return true
  }
}

/** Posts a single `PostItem` to `thread`, dispatching on its `kind`. */
async function postItem(thread: DiscordThread, item: PostItem): Promise<void> {
  switch (item.kind) {
    case 'typing': {
      await thread.sendTyping()
      return
    }
    case 'messages': {
      for (const text of item.texts) {
        await thread.send({ content: text })
      }
      return
    }
    case 'diff-inline': {
      await thread.send({ content: '```diff\n' + item.diffBlock + '\n```' })
      return
    }
    case 'diff-file': {
      await thread.send({
        content: item.header,
        files: [{ name: item.filename, data: item.content }],
      })
      // Explicit return for consistency with the other switch cases below.
      // eslint-disable-next-line no-useless-return
      return
    }
  }
}

async function postItems(
  thread: DiscordThread,
  items: PostItem[]
): Promise<void> {
  for (const item of items) {
    await postItem(thread, item)
  }
}

interface WorkerState {
  tailers: Map<string, JsonlTailer>
  consumedInputQueueIds: Set<string>
}

const stateByDependencies = new WeakMap<LogSyncDependencies, WorkerState>()

function getState(dependencies: LogSyncDependencies): WorkerState {
  let state = stateByDependencies.get(dependencies)
  if (!state) {
    state = { tailers: new Map(), consumedInputQueueIds: new Set() }
    stateByDependencies.set(dependencies, state)
  }
  return state
}

/** Processes one JSONL line: parse, format, post, then advance jsonl_offset. Skips ignored/invalid lines while still advancing the offset. */
async function processLine(
  dependencies: LogSyncDependencies,
  session: SessionRowForSync,
  thread: DiscordThread,
  consumedInputQueueIds: Set<string>,
  lineText: string,
  offsetAfter: number
): Promise<void> {
  const parsed = parseJsonlLine(lineText)
  if (!parsed || parsed.kind === 'ignored') {
    updateJsonlOffset(dependencies.db, session.id, offsetAfter)
    return
  }
  const pendingConsumedIds: string[] = []
  const items =
    parsed.kind === 'assistant'
      ? formatAssistantEntry(parsed.content)
      : formatUserEntry(
          parsed.content,
          makeEchoMatcher(
            dependencies.db,
            session.id,
            consumedInputQueueIds,
            pendingConsumedIds
          )
        )
  await postItems(thread, items)
  // Only merge matched echo IDs into the shared set once the whole line's
  // post has succeeded — see the doc comment on makeEchoMatcher.
  for (const id of pendingConsumedIds) {
    consumedInputQueueIds.add(id)
  }
  updateJsonlOffset(dependencies.db, session.id, offsetAfter)
}

/**
 * Reconciles the set of running tailers against the currently active
 * (non-`closed`) sessions: starts a tailer for each newly seen session and
 * stops/removes tailers for sessions no longer active.
 */
function reconcileTailers(
  dependencies: LogSyncDependencies,
  state: WorkerState
): void {
  const activeSessions = findActiveSessions(dependencies.db)
  const activeIds = new Set(activeSessions.map((session) => session.id))

  for (const [sessionId, tailer] of state.tailers) {
    if (activeIds.has(sessionId)) continue
    tailer.stop()
    state.tailers.delete(sessionId)
  }

  for (const session of activeSessions) {
    if (state.tailers.has(session.id)) continue
    const tailer = createJsonlTailer(
      session.jsonlPath,
      session.jsonlOffset,
      async (lines) => {
        const thread = await dependencies.getThread(session.threadId)
        if (!thread) return
        for (const line of lines) {
          // Always re-read the persisted offset: a retried batch may have
          // already had its earlier lines posted and committed before a
          // later line failed, and a prior line in this same loop iteration
          // may itself have just advanced it further.
          const currentOffset = getJsonlOffset(dependencies.db, session.id)
          if (line.offsetAfter <= currentOffset) continue
          await processLine(
            dependencies,
            session,
            thread,
            state.consumedInputQueueIds,
            line.text,
            line.offsetAfter
          )
        }
      }
    )
    tailer.start()
    state.tailers.set(session.id, tailer)
  }
}

/**
 * Runs one reconcile cycle for the JSONL → Discord sync: starts/stops
 * per-session tailers to match the current `sessions` table, mirroring
 * `runDetectionCycle`'s polling pattern. Intended to be called on an
 * interval (`dependencies.pollIntervalMs`) from `index.ts`.
 *
 * Declared `async` (though `reconcileTailers` itself is synchronous) to
 * match `runDetectionCycle`'s signature and keep the door open for future
 * awaited work here without a breaking signature change.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function runLogSyncCycle(
  dependencies: LogSyncDependencies
): Promise<void> {
  reconcileTailers(dependencies, getState(dependencies))
}
