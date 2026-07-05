/* eslint-disable unicorn/name-replacements */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Config } from '../config/schema.js'
import { openRegistryDb } from '../registry/db.js'
import { findSessionById } from '../registry/sessions.js'
import { AmbiguityTracker } from './ambiguity.js'
import { runDetectionCycle, type OrchestratorDeps } from './orchestrator.js'

vi.mock('../tmux/list-sessions.js', () => ({
  listTmuxSessions: vi.fn(),
  listTmuxPanes: vi.fn(),
}))
vi.mock('../tmux/process-tree.js', () => ({
  findClaudeProcessPid: vi.fn(),
}))
vi.mock('../tmux/proc.js', () => ({
  readProcessCwd: vi.fn(),
  readProcessEnviron: vi.fn(),
}))
vi.mock('../tmux/session-id-resolver.js', () => ({
  resolveContainerConfigDir: vi.fn(),
  resolveSessionId: vi.fn(),
}))

import { listTmuxPanes, listTmuxSessions } from '../tmux/list-sessions.js'
import { findClaudeProcessPid } from '../tmux/process-tree.js'
import { readProcessCwd, readProcessEnviron } from '../tmux/proc.js'
import {
  resolveContainerConfigDir,
  resolveSessionId,
} from '../tmux/session-id-resolver.js'

function makeConfig(): Config {
  return {
    guildId: 'guild-1',
    parentChannel: { type: 'forum', id: 'channel-1' },
    allowedUserIds: ['user-1'],
    workspaceRoots: ['/mnt/ssd/repos'],
    configDirs: [],
    tmux: { pollIntervalMs: 3000, socketDir: '/tmp/tmux-host' },
    sessionResolution: { ambiguityThresholdMs: 3000 },
    claude: {
      defaultConfigDir: {
        hostPath: '/home/user/.claude',
        containerPath: '/host/claude-config',
      },
      procRoot: '/proc',
    },
  }
}

/**
 * Builds a fresh `OrchestratorDeps` for a test, along with the individual
 * mock functions embedded in it. Assertions reference these local mock
 * function bindings directly (rather than the `deps.x.y` property access)
 * to avoid `@typescript-eslint/unbound-method` false positives on
 * interface-typed method properties.
 */
function makeDeps(): {
  deps: OrchestratorDeps
  createSessionThread: ReturnType<typeof vi.fn>
  promptSend: ReturnType<typeof vi.fn>
} {
  const createSessionThread = vi.fn().mockResolvedValue({ id: 'thread-1' })
  const promptSend = vi.fn()
  const deps: OrchestratorDeps = {
    db: openRegistryDb(':memory:'),
    parentChannel: { createSessionThread },
    promptChannel: { send: promptSend },
    ambiguityTracker: new AmbiguityTracker(),
    procRoot: '/proc',
    socketPath: '/tmp/tmux-host/default',
  }
  return { deps, createSessionThread, promptSend }
}

beforeEach(() => {
  vi.mocked(listTmuxSessions).mockReturnValue([{ name: 'tmux-1' }])
  vi.mocked(listTmuxPanes).mockReturnValue([{ paneId: '%0', pid: '100' }])
  vi.mocked(findClaudeProcessPid).mockReturnValue('300')
  vi.mocked(readProcessCwd).mockReturnValue('/mnt/ssd/repos/example')
  vi.mocked(readProcessEnviron).mockReturnValue({
    CLAUDE_CONFIG_DIR: '/home/user/.claude',
  })
  vi.mocked(resolveContainerConfigDir).mockReturnValue('/host/claude-config')
})

describe('runDetectionCycle', () => {
  it('creates a thread and registers a session when sessionId resolves', async () => {
    vi.mocked(resolveSessionId).mockReturnValue({
      kind: 'resolved',
      sessionId: 'session-1',
    })
    const { deps, createSessionThread } = makeDeps()

    await runDetectionCycle(deps, makeConfig())

    expect(createSessionThread).toHaveBeenCalledWith('session-1')
    expect(findSessionById(deps.db, 'session-1')).toBeDefined()
  })

  it('does nothing when no claude process is found in the pane', async () => {
    vi.mocked(findClaudeProcessPid).mockReturnValue(undefined)
    const { deps, createSessionThread } = makeDeps()

    await runDetectionCycle(deps, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('does not create a duplicate thread for an already-registered sessionId', async () => {
    vi.mocked(resolveSessionId).mockReturnValue({
      kind: 'resolved',
      sessionId: 'session-1',
    })
    const { deps, createSessionThread } = makeDeps()

    await runDetectionCycle(deps, makeConfig())
    await runDetectionCycle(deps, makeConfig())

    expect(createSessionThread).toHaveBeenCalledTimes(1)
  })

  it('does not create a thread while resolution is unresolved', async () => {
    vi.mocked(resolveSessionId).mockReturnValue({ kind: 'unresolved' })
    const { deps, createSessionThread } = makeDeps()

    await runDetectionCycle(deps, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('prompts for a selection when resolution is ambiguous, then registers the chosen sessionId', async () => {
    vi.mocked(resolveSessionId).mockReturnValue({
      kind: 'ambiguous',
      candidates: ['session-a', 'session-b'],
    })
    const { deps, createSessionThread, promptSend } = makeDeps()
    promptSend.mockResolvedValue({
      createMessageComponentCollector: () => ({
        on: (event: string, callback: (interaction: unknown) => void) => {
          if (event === 'collect') {
            callback({
              user: { id: 'user-1' },
              values: ['session-b'],
              reply: vi.fn(),
            })
          }
        },
      }),
    })

    await runDetectionCycle(deps, makeConfig())

    expect(createSessionThread).toHaveBeenCalledWith('session-b')
    expect(findSessionById(deps.db, 'session-b')).toBeDefined()
  })

  it('logs a warning and skips resolution when ambiguous but promptChannel is unavailable (forum parent)', async () => {
    vi.mocked(resolveSessionId).mockReturnValue({
      kind: 'ambiguous',
      candidates: ['session-a', 'session-b'],
    })
    const { deps, createSessionThread } = makeDeps()
    deps.promptChannel = undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await runDetectionCycle(deps, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('forum'),
      expect.anything()
    )
    warn.mockRestore()
  })
})
