/* eslint-disable unicorn/name-replacements */
import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ParentChannel } from '../discord/parent-channel.js'
import {
  findSessionById,
  insertSession,
  type SessionRow,
} from '../registry/sessions.js'
import { listAllTmuxPanes } from '../tmux/list-sessions.js'
import { readProcessCwd, readProcessEnviron } from '../tmux/proc.js'
import { findClaudeProcessPid } from '../tmux/process-tree.js'
import {
  resolveContainerConfigDir,
  resolveSessionId,
} from '../tmux/session-id-resolver.js'
import {
  AmbiguityTracker,
  promptSessionIdSelection,
  type PromptChannel,
} from './ambiguity.js'

/** External collaborators `runDetectionCycle` needs, injected for testability. */
export interface OrchestratorDeps {
  db: Database.Database
  parentChannel: ParentChannel
  /**
   * Channel to post the ambiguity Select menu to. `undefined` when
   * `config.parentChannel.type === 'forum'`, since a `ForumChannel` cannot
   * be posted to directly (§ Global Constraints) — ambiguous sessions are
   * logged and left unresolved in that configuration for Phase 1 (see the
   * forum-skip branch in `processPane` for the exact condition enforced).
   */
  promptChannel: PromptChannel | undefined
  ambiguityTracker: AmbiguityTracker
  procRoot: string
  socketPath: string
  /**
   * Panes (keyed by `${tmuxSession}:${panePid}`) whose sessionId has
   * already been resolved and registered, so their expensive resolution
   * pipeline can be skipped on subsequent detection cycles.
   */
  resolvedPanes: Set<string>
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
 * Returns true if `cwd` is inside one of `workspaceRoots` (§6). A root
 * matches if `cwd` equals it exactly or is a subdirectory of it.
 */
function isWithinWorkspaceRoots(
  cwd: string,
  workspaceRoots: string[]
): boolean {
  return workspaceRoots.some(
    (root) => cwd === root || cwd.startsWith(`${root}/`)
  )
}

/**
 * Registers `sessionId` (creating its Discord thread) unless it is already
 * registered (§4 step 6). Guards against concurrent registration of the
 * same sessionId from a parallel `processPane` call via
 * `deps.registeringSessionIds`.
 */
async function registerSession(
  deps: OrchestratorDeps,
  config: Config,
  sessionId: string,
  tmuxSession: string,
  panePid: string,
  cwd: string,
  containerConfigDir: string
): Promise<void> {
  if (findSessionById(deps.db, sessionId)) return
  if (deps.registeringSessionIds.has(sessionId)) return
  deps.registeringSessionIds.add(sessionId)

  try {
    const thread = await deps.parentChannel.createSessionThread(sessionId)
    const now = Date.now()
    const row: SessionRow = {
      id: sessionId,
      threadId: thread.id,
      parentChannelId: config.parentChannel.id,
      tmuxSession,
      tmuxPanePid: panePid,
      cwd,
      configDir: containerConfigDir,
      jsonlPath: `${containerConfigDir}/projects/${cwd.replaceAll('/', '-')}/${sessionId}.jsonl`,
      jsonlOffset: 0,
      status: 'discovered',
      createdAt: now,
      updatedAt: now,
    }
    insertSession(deps.db, row)
    deps.resolvedPanes.add(paneKey(tmuxSession, panePid))
  } finally {
    deps.registeringSessionIds.delete(sessionId)
  }
}

/**
 * Detects and resolves the Claude Code sessionId for a single tmux pane,
 * then registers it (§4 steps 2–6).
 */
async function processPane(
  deps: OrchestratorDeps,
  config: Config,
  tmuxSession: string,
  panePid: string
): Promise<void> {
  if (deps.resolvedPanes.has(paneKey(tmuxSession, panePid))) return

  const claudePid = await findClaudeProcessPid(deps.procRoot, panePid)
  if (!claudePid) return

  const cwd = await readProcessCwd(deps.procRoot, claudePid)
  if (!isWithinWorkspaceRoots(cwd, config.workspaceRoots)) return

  const environment = await readProcessEnviron(deps.procRoot, claudePid)
  const hostConfigDir =
    environment.CLAUDE_CONFIG_DIR ?? config.claude.defaultConfigDir.hostPath
  const containerConfigDir = resolveContainerConfigDir(config, hostConfigDir)

  const resolution = await resolveSessionId(
    deps.procRoot,
    containerConfigDir,
    claudePid,
    cwd,
    config.sessionResolution.ambiguityThresholdMs
  )

  if (resolution.kind === 'unresolved') return

  if (resolution.kind === 'ambiguous') {
    if (!deps.promptChannel) {
      // Phase 1 limitation: forum parent channels cannot host the Select
      // menu prompt (see OrchestratorDeps.promptChannel). Logs on every
      // detection cycle this pane remains ambiguous (not deduplicated),
      // and leaves the session unregistered.
      console.warn(
        'Ambiguous sessionId candidates found but the parent channel is a forum; skipping human resolution.',
        { tmuxSession, panePid, candidates: resolution.candidates }
      )
      return
    }
    if (deps.ambiguityTracker.isPending(tmuxSession, panePid)) return
    deps.ambiguityTracker.markPending(
      tmuxSession,
      panePid,
      resolution.candidates
    )
    const sessionId = await promptSessionIdSelection(
      deps.promptChannel,
      resolution.candidates,
      config
    )
    deps.ambiguityTracker.resolve(tmuxSession, panePid)
    if (sessionId === undefined) return
    await registerSession(
      deps,
      config,
      sessionId,
      tmuxSession,
      panePid,
      cwd,
      containerConfigDir
    )
    return
  }

  await registerSession(
    deps,
    config,
    resolution.sessionId,
    tmuxSession,
    panePid,
    cwd,
    containerConfigDir
  )
}

/** Runs one tmux detection / sessionId resolution / registration cycle (§4 steps 1–6). */
export async function runDetectionCycle(
  deps: OrchestratorDeps,
  config: Config
): Promise<void> {
  const panes = await listAllTmuxPanes(deps.socketPath)
  await Promise.all(
    panes.map((pane) => processPane(deps, config, pane.sessionName, pane.pid))
  )
}
