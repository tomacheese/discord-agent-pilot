import type Database from 'better-sqlite3'
import type { Config } from '../config/schema'
import type { ParentChannel } from '../discord/parent-channel'
import {
  findSessionById,
  insertSession,
  type SessionRow,
} from '../registry/sessions'
import { listAllTmuxPanes } from '../tmux/list-sessions'
import { readProcessCwd, readProcessEnviron } from '../tmux/proc'
import {
  findClaudeProcessPid,
  isClaudeProcessAlive,
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
   * Panes (keyed by `${tmuxSession}:${panePid}`) whose sessionId has
   * already been resolved and registered, mapped to the Claude process pid
   * that was registered. On a later cycle the cached pid is re-checked
   * cheaply via `isClaudeProcessAlive` before skipping the full resolution
   * pipeline: if the pane's shell (long-lived `panePid`) now hosts a
   * *different* `claude` invocation than the one that was cached (the
   * previous session exited and a new one started), the cache entry is
   * stale and the pane must be re-resolved rather than skipped forever.
   */
  resolvedPanes: Map<string, string>
  /**
   * SessionIds currently mid-registration, guarding against two panes that
   * resolve to the same sessionId within one parallelized detection cycle
   * both attempting to create a Discord thread / insert the same
   * `sessions.id` primary key.
   */
  registeringSessionIds: Set<string>
}

/** Builds the `resolvedPanes` cache key identifying a tmux session/pane pair. */
function paneKey(tmuxSession: string, panePid: string): string {
  return `${tmuxSession}:${panePid}`
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
 * Slugifies `cwd` into the directory name real Claude Code uses under
 * `~/.claude/projects/` for that working directory. Confirmed by inspecting
 * actual `~/.claude/projects/` entries: both `/` and `.` are replaced with
 * `-` (e.g. `/mnt/ssd/repos/github.com/foo` becomes
 * `-mnt-ssd-repos-github-com-foo`). Replacing only `/` (a bug found during
 * real-environment integration testing, Issue #13) leaves dots in the
 * result, which never matches the real on-disk directory whenever `cwd`
 * contains one — a case this very repository's own checkout path hits.
 */
function slugifyProjectCwd(cwd: string): string {
  return cwd.replaceAll(/[./]/g, '-')
}

/**
 * Registers `sessionId` (creating its Discord thread) unless it is already
 * registered. Guards against concurrent registration of the
 * same sessionId from a parallel `processPane` call via
 * `dependencies.registeringSessionIds`.
 */
async function registerSession(
  dependencies: OrchestratorDependencies,
  config: Config,
  sessionId: string,
  tmuxSession: string,
  panePid: string,
  claudePid: string,
  cwd: string,
  containerConfigDirectory: string
): Promise<void> {
  if (findSessionById(dependencies.db, sessionId)) return
  if (dependencies.registeringSessionIds.has(sessionId)) return
  dependencies.registeringSessionIds.add(sessionId)

  try {
    const thread =
      await dependencies.parentChannel.createSessionThread(sessionId)
    const now = Date.now()
    const row: SessionRow = {
      id: sessionId,
      threadId: thread.id,
      parentChannelId: config.parentChannel.id,
      tmuxSession,
      tmuxPanePid: panePid,
      cwd,
      configDir: containerConfigDirectory,
      jsonlPath: `${containerConfigDirectory}/projects/${slugifyProjectCwd(cwd)}/${sessionId}.jsonl`,
      jsonlOffset: 0,
      status: 'discovered',
      createdAt: now,
      updatedAt: now,
    }
    insertSession(dependencies.db, row)
    dependencies.resolvedPanes.set(paneKey(tmuxSession, panePid), claudePid)
  } finally {
    dependencies.registeringSessionIds.delete(sessionId)
  }
}

/**
 * Detects and resolves the Claude Code sessionId for a single tmux pane,
 * then registers it.
 */
async function processPane(
  dependencies: OrchestratorDependencies,
  config: Config,
  tmuxSession: string,
  panePid: string
): Promise<void> {
  const cachedClaudePid = dependencies.resolvedPanes.get(
    paneKey(tmuxSession, panePid)
  )
  if (
    cachedClaudePid !== undefined &&
    (await isClaudeProcessAlive(dependencies.procRoot, cachedClaudePid))
  ) {
    return
  }

  const claudePid = await findClaudeProcessPid(dependencies.procRoot, panePid)
  if (!claudePid) return

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
    const sessionId = await promptSessionIdSelection(
      dependencies.promptChannel,
      resolution.candidates,
      config
    )
    dependencies.ambiguityTracker.resolve(tmuxSession, panePid)
    if (sessionId === undefined) return
    await registerSession(
      dependencies,
      config,
      sessionId,
      tmuxSession,
      panePid,
      claudePid,
      cwd,
      containerConfigDirectory
    )
    return
  }

  await registerSession(
    dependencies,
    config,
    resolution.sessionId,
    tmuxSession,
    panePid,
    claudePid,
    cwd,
    containerConfigDirectory
  )
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
      processPane(dependencies, config, pane.sessionName, pane.pid)
    )
  )
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error(
        `Failed to process pane ${panes[index]?.sessionName ?? '(unknown)'}:`,
        result.reason
      )
    }
  }
}
