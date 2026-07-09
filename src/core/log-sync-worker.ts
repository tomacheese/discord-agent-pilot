import type Database from 'better-sqlite3'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { parseJsonlLine } from '../claude-log/parse'
import {
  formatAssistantEntry,
  formatUserEntry,
  type PostItem,
} from '../claude-log/format'
import { createJsonlTailer, type JsonlTailer } from '../claude-log/tail'
import {
  updateJsonlPath,
  updateThreadNameSource,
  type ThreadNameSource,
} from '../registry/sessions'
import { findLatestJsonlForSessionId } from '../tmux/session-id-resolver'
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
  configDir: string
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
      `SELECT id, thread_id AS threadId, config_dir AS configDir,
              jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset,
              thread_name_source AS threadNameSource
       FROM sessions WHERE status != 'closed'`
    )
    .all() as SessionRowForSync[]
}

/**
 * Persists `offset` as the new `jsonl_offset` for `sessionId`, but only if
 * `jsonlPath` still matches the session's currently-active JSONL file in
 * the DB. A mismatch means this session's jsonlPath was switched to a
 * different file (see `reconcileJsonlPaths`) after the tailer that
 * produced this write was created — the write becomes a no-op instead of
 * clobbering the newer tailer's freshly-reset offset with this stale,
 * superseded file's offset.
 */
function updateJsonlOffset(
  db: Database.Database,
  sessionId: string,
  jsonlPath: string,
  offset: number
): void {
  db.prepare(
    'UPDATE sessions SET jsonl_offset = ? WHERE id = ? AND jsonl_path = ?'
  ).run(offset, sessionId, jsonlPath)
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

/** Per-`LogSyncDependencies` mutable state: running tailers, echo-consumption bookkeeping, and jsonlPath-switch hysteresis. */
interface WorkerState {
  tailers: Map<string, JsonlTailer>
  consumedInputQueueIds: Set<string>
  /** Epoch ms of the most recent jsonlPath switch per sessionId, used by `reconcileJsonlPaths` for hysteresis (see `HYSTERESIS_MS`). */
  lastSwitchAtMs: Map<string, number>
  /**
   * Per-session map of jsonlPath -> the last-known offset this session
   * actually finished reading up to for that path. Recorded whenever a
   * tailer is drained/stopped (the OLD path) or when a new offset is seeded
   * for a path (the NEW path), so that a later round-trip back to a
   * previously-visited path resumes exactly where this session left off
   * instead of re-deriving (and potentially skipping) content (Issue #25).
   */
  pathOffsets: Map<string, Map<string, number>>
}

const stateByDependencies = new WeakMap<LogSyncDependencies, WorkerState>()

/** Returns the `WorkerState` for `dependencies`, creating and caching an empty one on first use. */
function getState(dependencies: LogSyncDependencies): WorkerState {
  let state = stateByDependencies.get(dependencies)
  if (!state) {
    state = {
      tailers: new Map(),
      consumedInputQueueIds: new Set(),
      lastSwitchAtMs: new Map(),
      pathOffsets: new Map(),
    }
    stateByDependencies.set(dependencies, state)
  }
  return state
}

/** Records `offset` as the last-known synced offset for `(sessionId, jsonlPath)` in `state.pathOffsets`. */
function recordPathOffset(
  state: WorkerState,
  sessionId: string,
  jsonlPath: string,
  offset: number
): void {
  let byPath = state.pathOffsets.get(sessionId)
  if (!byPath) {
    byPath = new Map()
    state.pathOffsets.set(sessionId, byPath)
  }
  byPath.set(jsonlPath, offset)
}

/**
 * Computes a safe starting offset for tailing `filePath` the first time this
 * session uses it: rather than seeding from the file's raw current byte
 * size (`stat().size`), which can land strictly inside a JSON line that is
 * still being written (a multi-write flush in progress) and cause the
 * tailer to treat that fragment as a complete line, this reads the file's
 * current content and rounds the offset DOWN to the last complete line
 * boundary — the byte index right after the last `\n` at or before the end
 * of the read content. Any trailing partial line is left for the tailer to
 * pick up naturally once its `\n` is actually written.
 *
 * Returns `0` if the file has no `\n` at all (empty, or a single incomplete
 * line), and falls back to `0` (with the error logged) if the file cannot
 * be read at all — e.g. a TOCTOU race where it vanished between resolution
 * and this read.
 */
async function computeSeedOffsetForNewPath(
  filePath: string,
  sessionId: string
): Promise<number> {
  try {
    const content = await readFile(filePath)
    const lastNewlineIndex = content.lastIndexOf('\n')
    return lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1
  } catch (error) {
    console.error(
      `Failed to stat new jsonlPath for session ${sessionId}, falling back to offset 0:`,
      error
    )
    return 0
  }
}

/**
 * Minimum time (ms) between jsonlPath switches for the same session. Right
 * after a cwd switch, the old file may still receive a few trailing writes
 * while the new file has already started growing; without this window, the
 * mtime comparison in `reconcileJsonlPaths` could flip back and forth
 * between the two for a few cycles. `Date.now()`-based rather than a cycle
 * counter, so it stays constant regardless of the configured
 * `pollIntervalMs` (see Issue #25's design doc).
 */
const HYSTERESIS_MS = 10_000

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
    updateJsonlOffset(
      dependencies.db,
      session.id,
      session.jsonlPath,
      offsetAfter
    )
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
    updateJsonlOffset(
      dependencies.db,
      session.id,
      session.jsonlPath,
      offsetAfter
    )
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
  updateJsonlOffset(dependencies.db, session.id, session.jsonlPath, offsetAfter)
}

/**
 * Re-resolves each active session's jsonlPath by an exact sessionId
 * filename match under `session.configDir`'s `projects/` directory, and
 * switches the session (DB row + in-memory `session` object + running
 * tailer, if any) onto a newly discovered file when the Claude Code
 * process's write target has moved — e.g. the process's cwd switched into
 * a git worktree mid-session (see Issue #25).
 *
 * Skips a session entirely (no re-resolution) for `HYSTERESIS_MS` after a
 * switch, to absorb the brief window where the old file may still receive
 * trailing writes and the mtime comparison could otherwise flip back and
 * forth between the two files.
 *
 * Before stopping the old tailer (if any), `tailer.flush()` is awaited so
 * any pending trailing bytes already appended to the OLD file are drained
 * and posted first; the tailer's resulting `getOffset()` is then recorded
 * into `state.pathOffsets` for `(session.id, session.jsonlPath)`, so no
 * appended-but-unsynced content is silently lost if this session later
 * switches back to that same file (e.g. a worktree round-trip).
 *
 * The new offset for `latest` is seeded in one of two ways:
 * - If this session has visited `latest` before (`state.pathOffsets` has an
 *   entry for `(session.id, latest)` — the round-trip case), that recorded
 *   offset is reused directly, resuming exactly where this session left
 *   off on that file with no content skipped or duplicated.
 * - Otherwise (first time this session has ever used `latest`), the offset
 *   is computed via `computeSeedOffsetForNewPath`: rather than the file's
 *   raw current byte size (which can land inside a JSON line still being
 *   written, mid-flush), it rounds down to the last complete line boundary
 *   so the tailer never starts mid-line. This still avoids re-posting the
 *   file's pre-existing historical content as new (Issue #25 review
 *   finding), without the mid-write race a raw `stat().size` seed would
 *   have. Any read/stat failure (e.g. a TOCTOU race where `latest` vanished
 *   between resolution and read) falls back to offset `0`, with the error
 *   logged.
 *
 * The resulting offset (from either source) is also recorded into
 * `state.pathOffsets` for `(session.id, latest)`, so a later round-trip
 * back to this exact path benefits the same way.
 *
 * Runs one check per session in parallel via `Promise.allSettled`, mirroring
 * `orchestrator.ts`'s pane-processing pattern: one session's resolution
 * failure must not block the others in the same cycle.
 */
async function reconcileJsonlPaths(
  dependencies: LogSyncDependencies,
  state: WorkerState,
  activeSessions: SessionRowForSync[]
): Promise<void> {
  const results = await Promise.allSettled(
    activeSessions.map(async (session) => {
      const lastSwitchAt = state.lastSwitchAtMs.get(session.id)
      if (
        lastSwitchAt !== undefined &&
        Date.now() - lastSwitchAt < HYSTERESIS_MS
      ) {
        return
      }

      const projectsRoot = path.join(session.configDir, 'projects')
      const latest = await findLatestJsonlForSessionId(projectsRoot, session.id)
      if (latest === undefined || latest === session.jsonlPath) return

      const tailer = state.tailers.get(session.id)
      if (tailer) {
        try {
          await tailer.flush()
        } finally {
          try {
            tailer.stop()
          } catch (error) {
            console.error(
              `Failed to stop tailer for session ${session.id} during jsonlPath switch:`,
              error
            )
          } finally {
            state.tailers.delete(session.id)
          }
        }
        recordPathOffset(
          state,
          session.id,
          session.jsonlPath,
          tailer.getOffset()
        )
      }

      const rememberedOffset = state.pathOffsets.get(session.id)?.get(latest)
      const newOffset =
        rememberedOffset ??
        (await computeSeedOffsetForNewPath(latest, session.id))
      recordPathOffset(state, session.id, latest, newOffset)
      updateJsonlPath(dependencies.db, session.id, latest, newOffset)
      session.jsonlPath = latest
      session.jsonlOffset = newOffset
      state.lastSwitchAtMs.set(session.id, Date.now())
    })
  )
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue
    const session = activeSessions[index]
    console.error(
      `Failed to reconcile jsonlPath for session ${session.id}:`,
      result.reason
    )
  }
}

/**
 * Reconciles the set of running tailers against `activeSessions`: starts a
 * tailer for each newly seen session and stops/removes tailers for
 * sessions no longer active.
 */
function reconcileTailers(
  dependencies: LogSyncDependencies,
  state: WorkerState,
  activeSessions: SessionRowForSync[]
): void {
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
 * Runs one reconcile cycle for the JSONL → Discord sync: first re-resolves
 * each active session's jsonlPath (see `reconcileJsonlPaths`), then
 * starts/stops per-session tailers to match the current `sessions` table
 * (see `reconcileTailers`), mirroring `runDetectionCycle`'s polling pattern.
 * Intended to be called on an interval (`dependencies.pollIntervalMs`) from
 * `index.ts`.
 */
export async function runLogSyncCycle(
  dependencies: LogSyncDependencies
): Promise<void> {
  const state = getState(dependencies)
  const activeSessions = findActiveSessions(dependencies.db)
  await reconcileJsonlPaths(dependencies, state, activeSessions)
  reconcileTailers(dependencies, state, activeSessions)
}
