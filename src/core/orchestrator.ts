import type Database from 'better-sqlite3'
import type { Config } from '../config/schema'
import type { ParentChannel } from '../discord/parent-channel'
import { buildFallbackThreadTitle } from '../discord/thread-title'
import { formatThreadStatus } from '../discord/thread-status'
import { failPendingInputs } from '../registry/input-queue'
import {
  findOpenSessions,
  findOpenSessionsByPaneId,
  findSessionById,
  insertSession,
  markSessionClosed,
  rebindSession,
  type SessionBinding,
  type SessionRow,
} from '../registry/sessions'
import { listAllTmuxPanes } from '../tmux/list-sessions'
import {
  readProcessCwd,
  readProcessEnviron,
  readProcessStartTicks,
} from '../tmux/proc'
import {
  findClaudeProcessPid,
  isClaudeProcessIdentityAlive,
} from '../tmux/process-tree'
import {
  resolveContainerConfigDirectory,
  resolveSessionId,
} from '../tmux/session-id-resolver'
import {
  AmbiguityTracker,
  promptSessionIdSelection,
  type PromptChannel,
} from './ambiguity'
import { isSessionProcessAlive } from './session-liveness'
import {
  THREAD_STATUS_MIN_INTERVAL_MS,
  ThreadStatusTracker,
} from './thread-status-tracker'

/** External collaborators `runDetectionCycle` needs, injected for testability. */
export interface OrchestratorDependencies {
  db: Database.Database
  parentChannel: ParentChannel
  /**
   * Channel to post the ambiguity Select menu to. `undefined` when
   * `config.parentChannel.type === 'forum'`, since a `ForumChannel` cannot
   * be posted to directly — ambiguous sessions are
   * logged and left unresolved in that configuration for Phase 1 (see the
   * forum-skip branch in `processPane` for the exact condition enforced).
   */
  promptChannel: PromptChannel | undefined
  ambiguityTracker: AmbiguityTracker
  procRoot: string
  socketPath: string
  /**
   * SessionIds currently mid-registration, guarding against two panes that
   * resolve to the same sessionId within one parallelized detection cycle
   * both attempting to create a Discord thread / insert the same
   * `sessions.id` primary key.
   */
  registeringSessionIds: Set<string>
  /** Tracks each thread's last-applied starter message content, to skip redundant Discord edits (see `updateThreadStatuses`). */
  statusTracker: ThreadStatusTracker
}

/**
 * Returns true if `cwd` is inside one of `workspaceRoots`. A root
 * matches if `cwd` equals it exactly or is a subdirectory of it. Trailing
 * slashes on a configured root are trimmed first, since otherwise a root
 * like `/mnt/ssd/repos/` would build the prefix `/mnt/ssd/repos//` and never
 * match any real `cwd`.
 */
function isWithinWorkspaceRoots(
  cwd: string,
  workspaceRoots: string[]
): boolean {
  return workspaceRoots.some((root) => {
    const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root
    return cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`)
  })
}

/**
 * Marks `session` closed, fails its still-pending input (it was queued for a
 * process that no longer backs the session, so it must not be delivered to a
 * later process the session is resumed in), and archives its Discord thread
 * for a forum parent channel. Text-channel threads are not archived.
 *
 * The DB close is authoritative regardless of the Discord API outcome: an
 * `archiveThread` failure is logged and skipped so it never blocks the
 * session from being marked closed.
 */
async function closeSession(
  dependencies: OrchestratorDependencies,
  config: Config,
  session: SessionRow
): Promise<void> {
  markSessionClosed(dependencies.db, session.id)
  failPendingInputs(dependencies.db, session.id)

  if (config.parentChannel.type !== 'forum') return
  try {
    await dependencies.parentChannel.archiveThread?.(session.threadId)
  } catch (error) {
    console.error(
      `Failed to archive thread ${session.threadId} for session ${session.id}:`,
      error
    )
  }
}

/**
 * Closes every open session bound to `paneId` other than `keepSessionId`.
 * A pane hosts one Claude process, so once `keepSessionId` is bound to it any
 * other open row for the pane is stale. Rows are closed independently: one
 * failing must not leave the others open.
 */
async function closeOtherSessionsInPane(
  dependencies: OrchestratorDependencies,
  config: Config,
  paneId: string,
  keepSessionId: string
): Promise<void> {
  const stale = findOpenSessionsByPaneId(dependencies.db, paneId).filter(
    (session) => session.id !== keepSessionId
  )
  const results = await Promise.allSettled(
    stale.map((session) => closeSession(dependencies, config, session))
  )
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue
    console.error(
      `Failed to close session ${stale[index].id} replaced in pane ${paneId}:`,
      result.reason
    )
  }
}

/** Returns true if `session` is already open and bound to exactly `binding`. */
function isBoundTo(session: SessionRow, binding: SessionBinding): boolean {
  return (
    session.status !== 'closed' &&
    session.tmuxPaneId === binding.tmuxPaneId &&
    session.claudePid === binding.claudePid &&
    session.claudeStartTicks === binding.claudeStartTicks
  )
}

/**
 * Binds `resolved.sessionId` to the tmux pane and Claude process in
 * `binding`, then closes the other open sessions of that pane.
 *
 * - Unknown session: creates its Discord thread and inserts the row.
 * - Known session already bound to `binding`: nothing to do.
 * - Known session otherwise (resumed after being closed, moved to another
 *   pane, or restarted as a new process): rebinds the existing row, keeping
 *   its thread and log offset, and unarchives the thread if it was closed.
 *
 * Guards against concurrent registration of the same sessionId from a
 * parallel `processPane` call via `dependencies.registeringSessionIds`.
 */
async function registerSession(
  dependencies: OrchestratorDependencies,
  config: Config,
  resolved: { sessionId: string; jsonlPath: string },
  binding: SessionBinding,
  cwd: string,
  containerConfigDirectory: string
): Promise<void> {
  const { sessionId } = resolved
  if (dependencies.registeringSessionIds.has(sessionId)) return
  dependencies.registeringSessionIds.add(sessionId)

  try {
    const existing = findSessionById(dependencies.db, sessionId)
    if (existing) {
      if (isBoundTo(existing, binding)) return
      rebindSession(dependencies.db, sessionId, binding)
      if (
        existing.status === 'closed' &&
        config.parentChannel.type === 'forum'
      ) {
        try {
          await dependencies.parentChannel.unarchiveThread?.(existing.threadId)
        } catch (error) {
          console.error(
            `Failed to unarchive thread ${existing.threadId} for session ${sessionId}:`,
            error
          )
        }
      }
    } else {
      const thread = await dependencies.parentChannel.createSessionThread(
        buildFallbackThreadTitle(cwd, binding.tmuxSession)
      )
      const now = Date.now()
      const row: SessionRow = {
        id: sessionId,
        threadId: thread.id,
        parentChannelId: config.parentChannel.id,
        ...binding,
        cwd,
        configDir: containerConfigDirectory,
        jsonlPath: resolved.jsonlPath,
        jsonlOffset: 0,
        status: 'discovered',
        threadNameSource: 'fallback',
        lastActionSummary: '',
        createdAt: now,
        updatedAt: now,
      }
      insertSession(dependencies.db, row)
    }
    await closeOtherSessionsInPane(
      dependencies,
      config,
      binding.tmuxPaneId,
      sessionId
    )
  } finally {
    dependencies.registeringSessionIds.delete(sessionId)
  }
}

/**
 * Reads the start time of `pid`, or returns undefined if it cannot be used
 * as part of a process identity: the process already exited (`ENOENT`, an
 * expected race) or its `stat` is malformed (logged). Other read errors
 * propagate.
 */
async function readStartTicksIfRunning(
  procRoot: string,
  pid: string
): Promise<number | undefined> {
  try {
    const startTicks = await readProcessStartTicks(procRoot, pid)
    if (Number.isNaN(startTicks)) {
      console.warn(`Malformed start time in stat for pid ${pid}; skipping pane`)
      return undefined
    }
    return startTicks
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Returns true if an open session of `paneId` is bound to a Claude process
 * that is still running, in which case the pane needs no re-resolution. Legacy
 * rows without a recorded identity never count, so the next resolution adopts
 * an identity for them.
 */
async function hasLiveBoundSession(
  dependencies: OrchestratorDependencies,
  paneId: string
): Promise<boolean> {
  for (const session of findOpenSessionsByPaneId(dependencies.db, paneId)) {
    if (
      session.claudePid !== '' &&
      (await isClaudeProcessIdentityAlive(
        dependencies.procRoot,
        session.claudePid,
        session.claudeStartTicks
      ))
    ) {
      return true
    }
  }
  return false
}

/**
 * Detects and resolves the Claude Code sessionId for a single tmux pane,
 * then registers it.
 */
async function processPane(
  dependencies: OrchestratorDependencies,
  config: Config,
  tmuxSession: string,
  panePid: string,
  paneId: string
): Promise<void> {
  if (await hasLiveBoundSession(dependencies, paneId)) return

  const claudePid = await findClaudeProcessPid(dependencies.procRoot, panePid)
  if (!claudePid) return

  const claudeStartTicks = await readStartTicksIfRunning(
    dependencies.procRoot,
    claudePid
  )
  if (claudeStartTicks === undefined) return
  const binding: SessionBinding = {
    tmuxSession,
    tmuxPanePid: panePid,
    tmuxPaneId: paneId,
    claudePid,
    claudeStartTicks,
  }

  const cwd = await readProcessCwd(dependencies.procRoot, claudePid)
  if (!isWithinWorkspaceRoots(cwd, config.workspaceRoots)) return

  const environment = await readProcessEnviron(dependencies.procRoot, claudePid)
  const hostConfigDirectory =
    environment.CLAUDE_CONFIG_DIR ?? config.claude.defaultConfigDir.hostPath
  const containerConfigDirectory = resolveContainerConfigDirectory(
    config,
    hostConfigDirectory
  )

  const resolution = await resolveSessionId(
    dependencies.procRoot,
    containerConfigDirectory,
    claudePid,
    cwd,
    config.sessionResolution.ambiguityThresholdMs
  )

  if (resolution.kind === 'unresolved') return

  if (resolution.kind === 'ambiguous') {
    if (!dependencies.promptChannel) {
      // Phase 1 limitation: forum parent channels cannot host the Select
      // menu prompt (see OrchestratorDependencies.promptChannel). Logs on every
      // detection cycle this pane remains ambiguous (not deduplicated),
      // and leaves the session unregistered.
      console.warn(
        'Ambiguous sessionId candidates found but the parent channel is a forum; skipping human resolution.',
        { tmuxSession, panePid, candidates: resolution.candidates }
      )
      return
    }
    if (dependencies.ambiguityTracker.isPending(tmuxSession, panePid)) return
    dependencies.ambiguityTracker.markPending(
      tmuxSession,
      panePid,
      resolution.candidates
    )
    let selected
    try {
      selected = await promptSessionIdSelection(
        dependencies.promptChannel,
        resolution.candidates,
        config
      )
    } finally {
      dependencies.ambiguityTracker.resolve(tmuxSession, panePid)
    }
    if (!selected) return
    await registerSession(
      dependencies,
      config,
      selected,
      binding,
      cwd,
      containerConfigDirectory
    )
    return
  }

  await registerSession(
    dependencies,
    config,
    resolution,
    binding,
    cwd,
    containerConfigDirectory
  )
}

/** Closes `session` (see `closeSession`) if the Claude process it is bound to has exited; leaves it untouched otherwise. */
async function closeSessionIfExited(
  dependencies: OrchestratorDependencies,
  config: Config,
  session: SessionRow
): Promise<void> {
  if (await isSessionProcessAlive(dependencies.procRoot, session)) return
  await closeSession(dependencies, config, session)
}

/**
 * Runs `closeSessionIfExited` for every session in `openSessions`. Sessions
 * are checked independently via `Promise.allSettled`, mirroring
 * `runDetectionCycle`'s pane processing below: a single session whose
 * liveness check throws must not block the rest of this cycle's open
 * sessions from being checked.
 */
async function closeExitedSessions(
  dependencies: OrchestratorDependencies,
  config: Config,
  openSessions: SessionRow[]
): Promise<void> {
  const results = await Promise.allSettled(
    openSessions.map((session) =>
      closeSessionIfExited(dependencies, config, session)
    )
  )
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue
    const session = openSessions[index]
    console.error(
      `Failed to check exit status for session ${session.id}:`,
      result.reason
    )
  }
}

/**
 * Updates each open forum session's thread starter message to reflect its
 * current status (running/stopped, most recent action, elapsed time).
 * No-op entirely when the parent channel is not a forum, since only forum
 * threads have a starter message.
 *
 * Liveness is checked with `isSessionProcessAlive`, like
 * `closeSessionIfExited`. Each session's computed
 * content is only sent to Discord when `dependencies.statusTracker` says it
 * actually changed and enough time has passed since the last edit, keeping
 * this well within Discord's message-edit rate limit even with many open
 * sessions.
 */
async function updateThreadStatuses(
  dependencies: OrchestratorDependencies,
  config: Config,
  openSessions: SessionRow[]
): Promise<void> {
  if (config.parentChannel.type !== 'forum') return

  const now = Date.now()
  const results = await Promise.allSettled(
    openSessions.map(async (session) => {
      const isRunning = await isSessionProcessAlive(
        dependencies.procRoot,
        session
      )

      const content = formatThreadStatus({
        isRunning,
        lastActionSummary: session.lastActionSummary,
        elapsedMinutes: Math.floor((now - session.createdAt) / 60_000),
      })

      if (
        !dependencies.statusTracker.shouldUpdate(
          session.threadId,
          content,
          now,
          THREAD_STATUS_MIN_INTERVAL_MS
        )
      ) {
        return
      }

      await dependencies.parentChannel.updateThreadStatus?.(
        session.threadId,
        content
      )
      dependencies.statusTracker.recordUpdate(session.threadId, content, now)
    })
  )
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue
    const session = openSessions[index]
    console.error(
      `Failed to update thread status for session ${session.id}:`,
      result.reason
    )
  }
}

/**
 * Runs one tmux detection / sessionId resolution / registration cycle.
 *
 * Panes are processed independently via `Promise.allSettled` rather than
 * `Promise.all`: a single pane that fails (e.g. a Claude Code process whose
 * config dir isn't listed in `configDirs`, which is expected whenever an
 * unrelated session shares the same host tmux server) must not prevent the
 * other panes in the same cycle from being detected and registered, nor be
 * reported as if the whole cycle failed.
 */
export async function runDetectionCycle(
  dependencies: OrchestratorDependencies,
  config: Config
): Promise<void> {
  const panes = await listAllTmuxPanes(dependencies.socketPath)
  const results = await Promise.allSettled(
    panes.map((pane) =>
      processPane(dependencies, config, pane.sessionName, pane.pid, pane.paneId)
    )
  )
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue
    const pane = panes[index]
    console.error(
      `Failed to process pane ${pane.sessionName} ` +
        `(paneId=${pane.paneId}, pid=${pane.pid}):`,
      result.reason
    )
  }
  const openSessions = findOpenSessions(dependencies.db)
  await closeExitedSessions(dependencies, config, openSessions)
  await updateThreadStatuses(dependencies, config, openSessions)
}
