/* eslint-disable unicorn/name-replacements */
import type Database from 'better-sqlite3'
import type { Config } from '../config/schema.js'
import type { ParentChannel } from '../discord/parent-channel.js'
import {
  findSessionById,
  insertSession,
  type SessionRow,
} from '../registry/sessions.js'
import { listTmuxPanes, listTmuxSessions } from '../tmux/list-sessions.js'
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
   * logged and left unresolved in that configuration for Phase 1.
   */
  promptChannel: PromptChannel | undefined
  ambiguityTracker: AmbiguityTracker
  procRoot: string
  socketPath: string
}

/**
 * Registers `sessionId` (creating its Discord thread) unless it is already
 * registered (§4 step 6).
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
  const claudePid = findClaudeProcessPid(deps.procRoot, panePid)
  if (!claudePid) return

  const cwd = readProcessCwd(deps.procRoot, claudePid)
  const environment = readProcessEnviron(deps.procRoot, claudePid)
  // `readProcessEnviron` returns `Record<string, string>`, but an
  // arbitrary env var key may legitimately be absent at runtime; the cast
  // reflects that so `??` isn't flagged as unnecessary by the type
  // checker's (overly narrow) inferred index signature.
  const hostConfigDir =
    (environment as Record<string, string | undefined>).CLAUDE_CONFIG_DIR ??
    config.claude.defaultConfigDir.hostPath
  const containerConfigDir = resolveContainerConfigDir(config, hostConfigDir)

  const resolution = resolveSessionId(
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
      // menu prompt (see OrchestratorDeps.promptChannel). Log once per
      // detection cycle and leave the session unregistered.
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
  const sessions = listTmuxSessions(deps.socketPath)
  for (const session of sessions) {
    const panes = listTmuxPanes(deps.socketPath, session.name)
    for (const pane of panes) {
      await processPane(deps, config, session.name, pane.pid)
    }
  }
}
