import type Database from 'better-sqlite3'
import { parseJsonlLine } from '../claude-log/parse'
import {
  formatAssistantEntry,
  formatUserEntry,
  type PostItem,
} from '../claude-log/format'
import { createJsonlTailer, type JsonlTailer } from '../claude-log/tail'
import {
  updateThreadNameSource,
  type ThreadNameSource,
} from '../registry/sessions'
import { truncateThreadTitle } from '../discord/thread-title'

/**
 * A single Discord post: plain text and/or file attachments. The union
 * requires at least one of `content`/`files` to be set, enforced at compile
 * time.
 */
export type SendInput =
  | { content: string; files?: { name: string; data: string | Buffer }[] }
  | { content?: string; files: { name: string; data: string | Buffer }[] }

/** The subset of a Discord thread's API this worker needs. */
export interface DiscordThread {
  send: (input: SendInput) => Promise<unknown>
  sendTyping: () => Promise<void>
  setName: (name: string) => Promise<unknown>
}

/** Dependencies injected into the log sync worker: DB access, thread resolution, and the caller's poll interval. */
export interface LogSyncDependencies {
  db: Database.Database
  getThread: (threadId: string) => Promise<DiscordThread | undefined>
  /** Interval, in milliseconds, at which the caller (index.ts) re-invokes runLogSyncCycle. */
  pollIntervalMs: number
}

/** The subset of a `sessions` row needed to tail its JSONL file and sync it to Discord. */
interface SessionRowForSync {
  id: string
  threadId: string
  jsonlPath: string
  jsonlOffset: number
  threadNameSource: ThreadNameSource
}

/** An `input_queue` row in `state = 'sent'`, as read for echo matching. */
interface PendingInputQueueRow {
  id: number
  body: string
}

/** Reads all sessions that are not `closed`, i.e. eligible for JSONL tailing. */
function findActiveSessions(db: Database.Database): SessionRowForSync[] {
  return db
    .prepare(
      `SELECT id, thread_id AS threadId, jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset,
              thread_name_source AS threadNameSource
       FROM sessions WHERE status != 'closed'`
    )
    .all() as SessionRowForSync[]
}

/** Persists `offset` as the new `jsonl_offset` for `sessionId`. */
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

/** Reads all `input_queue` rows for `sessionId` still in `state = 'sent'` (candidates for echo matching). */
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
    }
  }
}

/** Posts each `PostItem` in `items` to `thread`, in order. */
async function postItems(
  thread: DiscordThread,
  items: PostItem[]
): Promise<void> {
  for (const item of items) {
    await postItem(thread, item)
  }
}

/** Per-`LogSyncDependencies` mutable state: running tailers and echo-consumption bookkeeping. */
interface WorkerState {
  tailers: Map<string, JsonlTailer>
  consumedInputQueueIds: Set<string>
}

const stateByDependencies = new WeakMap<LogSyncDependencies, WorkerState>()

/** Returns the `WorkerState` for `dependencies`, creating and caching an empty one on first use. */
function getState(dependencies: LogSyncDependencies): WorkerState {
  let state = stateByDependencies.get(dependencies)
  if (!state) {
    state = { tailers: new Map(), consumedInputQueueIds: new Set() }
    stateByDependencies.set(dependencies, state)
  }
  return state
}

/** Numeric priority of each `ThreadNameSource`, used to decide whether a new title may replace the currently-applied one. */
const SOURCE_RANK: Record<ThreadNameSource, number> = {
  fallback: 0,
  'ai-title': 1,
  'agent-name': 2,
}

/** Returns true if `candidate` should replace the currently-applied `current` source. */
function shouldApplyThreadName(
  current: ThreadNameSource,
  candidate: ThreadNameSource
): boolean {
  return SOURCE_RANK[candidate] >= SOURCE_RANK[current]
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
  if (parsed.kind === 'agent-name' || parsed.kind === 'ai-title') {
    const candidateSource: ThreadNameSource =
      parsed.kind === 'agent-name' ? 'agent-name' : 'ai-title'
    const candidateTitle =
      parsed.kind === 'agent-name' ? parsed.agentName : parsed.aiTitle
    if (shouldApplyThreadName(session.threadNameSource, candidateSource)) {
      await thread.setName(truncateThreadTitle(candidateTitle))
      updateThreadNameSource(dependencies.db, session.id, candidateSource)
      // Keep the in-memory session object (captured for this tailer's whole
      // lifetime) in sync with what was just persisted, so a later line in
      // the same tailer does not compare against a stale source and
      // incorrectly downgrade an already-applied name (e.g. agent-name ->
      // ai-title).
      session.threadNameSource = candidateSource
    }
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
  try {
    await postItems(thread, items)
  } catch (error) {
    // A line whose post keeps failing (e.g. Discord rejects the message
    // body) must not block the tailer forever: skip it and advance past
    // it instead of retrying indefinitely. See Issue #23.
    console.error(
      `Failed to post line for session ${session.id}; skipping line:`,
      error
    )
    updateJsonlOffset(dependencies.db, session.id, offsetAfter)
    return
  }
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
        if (!thread) {
          // Reject (rather than silently returning) so `tail.ts` retries this
          // batch on the next detected change instead of permanently
          // advancing its in-memory offset past it (see the `onLines`
          // contract documented on `createJsonlTailer`).
          throw new Error(`Thread ${session.threadId} not found; will retry`)
        }
        // Read the persisted offset once per batch (rather than once per
        // line): nothing else can mutate this session's offset concurrently
        // while this callback is running, since `tail.ts` serializes calls
        // via `processingChain` and `index.ts` guards against overlapping
        // cycles. The local variable is then kept in sync with what
        // `processLine` persists after each successfully processed line.
        let currentOffset = getJsonlOffset(dependencies.db, session.id)
        for (const line of lines) {
          // A retried batch may have already had its earlier lines posted
          // and committed before a later line failed; skip those.
          if (line.offsetAfter <= currentOffset) continue
          await processLine(
            dependencies,
            session,
            thread,
            state.consumedInputQueueIds,
            line.text,
            line.offsetAfter
          )
          currentOffset = line.offsetAfter
        }
      },
      dependencies.pollIntervalMs
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
