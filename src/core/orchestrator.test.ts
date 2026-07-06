import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Config } from '../config/schema'
import { openRegistryDb } from '../registry/db'
import { findSessionById } from '../registry/sessions'
import { AmbiguityTracker } from './ambiguity'
import {
  runDetectionCycle,
  type OrchestratorDependencies,
} from './orchestrator'

vi.mock('../tmux/list-sessions', () => ({
  listAllTmuxPanes: vi.fn(),
}))
vi.mock('../tmux/process-tree', () => ({
  findClaudeProcessPid: vi.fn(),
  isClaudeProcessAlive: vi.fn(),
}))
vi.mock('../tmux/proc', () => ({
  readProcessCwd: vi.fn(),
  readProcessEnviron: vi.fn(),
}))
vi.mock('../tmux/session-id-resolver', () => ({
  resolveContainerConfigDirectory: vi.fn(),
  resolveSessionId: vi.fn(),
}))

import { listAllTmuxPanes } from '../tmux/list-sessions'
import {
  findClaudeProcessPid,
  isClaudeProcessAlive,
} from '../tmux/process-tree'
import { readProcessCwd, readProcessEnviron } from '../tmux/proc'
import {
  resolveContainerConfigDirectory,
  resolveSessionId,
} from '../tmux/session-id-resolver'

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
 * Builds a fresh `OrchestratorDependencies` for a test, along with the individual
 * mock functions embedded in it. Assertions reference these local mock
 * function bindings directly (rather than the `dependencies.x.y` property access)
 * to avoid `@typescript-eslint/unbound-method` false positives on
 * interface-typed method properties.
 */
function makeDependencies(): {
  dependencies: OrchestratorDependencies
  createSessionThread: ReturnType<typeof vi.fn>
  promptSend: ReturnType<typeof vi.fn>
} {
  const createSessionThread = vi.fn().mockResolvedValue({ id: 'thread-1' })
  const promptSend = vi.fn()
  const dependencies: OrchestratorDependencies = {
    db: openRegistryDb(':memory:'),
    parentChannel: { createSessionThread },
    promptChannel: { send: promptSend },
    ambiguityTracker: new AmbiguityTracker(),
    procRoot: '/proc',
    socketPath: '/tmp/tmux-host/default',
    resolvedPanes: new Map(),
    registeringSessionIds: new Set(),
  }
  return { dependencies, createSessionThread, promptSend }
}

beforeEach(() => {
  vi.mocked(listAllTmuxPanes)
    .mockReset()
    .mockResolvedValue([{ sessionName: 'tmux-1', paneId: '%0', pid: '100' }])
  vi.mocked(findClaudeProcessPid).mockReset().mockResolvedValue('300')
  vi.mocked(isClaudeProcessAlive).mockReset().mockResolvedValue(true)
  vi.mocked(readProcessCwd)
    .mockReset()
    .mockResolvedValue('/mnt/ssd/repos/example')
  vi.mocked(readProcessEnviron).mockReset().mockResolvedValue({
    CLAUDE_CONFIG_DIR: '/home/user/.claude',
  })
  vi.mocked(resolveContainerConfigDirectory)
    .mockReset()
    .mockReturnValue('/host/claude-config')
  vi.mocked(resolveSessionId).mockReset()
})

describe('runDetectionCycle', () => {
  it('creates a thread and registers a session when sessionId resolves', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
    })
    const { dependencies, createSessionThread } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).toHaveBeenCalledWith('session-1')
    expect(findSessionById(dependencies.db, 'session-1')).toBeDefined()
  })

  it('does nothing when no claude process is found in the pane', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue(undefined)
    const { dependencies, createSessionThread } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('does not create a duplicate thread for an already-registered sessionId', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
    })
    const { dependencies, createSessionThread } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())
    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).toHaveBeenCalledTimes(1)
  })

  it('does not create a thread while resolution is unresolved', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({ kind: 'unresolved' })
    const { dependencies, createSessionThread } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('does not create a thread when cwd is outside all workspaceRoots', async () => {
    vi.mocked(readProcessCwd).mockResolvedValue('/etc/somewhere-else')
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
    })
    const { dependencies, createSessionThread } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('skips the resolution pipeline for a pane whose cached claude process is still alive', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    dependencies.resolvedPanes.set('tmux-1:100', '300')

    await runDetectionCycle(dependencies, makeConfig())

    expect(isClaudeProcessAlive).toHaveBeenCalledWith('/proc', '300')
    expect(findClaudeProcessPid).not.toHaveBeenCalled()
    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('re-runs resolution when the pane cache is stale (previous claude process exited)', async () => {
    vi.mocked(isClaudeProcessAlive).mockResolvedValue(false)
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-2',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    // A prior session ('session-1', pid 300) was registered in this pane;
    // that process has since exited and a new claude process (pid 300,
    // reused by mockResolvedValue('300') as the "new" process for
    // simplicity) started in the same pane.
    dependencies.resolvedPanes.set('tmux-1:100', '300')

    await runDetectionCycle(dependencies, makeConfig())

    expect(findClaudeProcessPid).toHaveBeenCalledWith('/proc', '100')
    expect(createSessionThread).toHaveBeenCalledWith('session-2')
    expect(findSessionById(dependencies.db, 'session-2')).toBeDefined()
  })

  it('prompts for a selection when resolution is ambiguous, then registers the chosen sessionId', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'ambiguous',
      candidates: ['session-a', 'session-b'],
    })
    const { dependencies, createSessionThread, promptSend } = makeDependencies()
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
        stop: vi.fn(),
      }),
    })

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).toHaveBeenCalledWith('session-b')
    expect(findSessionById(dependencies.db, 'session-b')).toBeDefined()
  })

  it('does not register a session when the ambiguity prompt times out', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'ambiguous',
      candidates: ['session-a', 'session-b'],
    })
    const { dependencies, createSessionThread, promptSend } = makeDependencies()
    promptSend.mockResolvedValue({
      createMessageComponentCollector: () => ({
        on: (
          event: string,
          callback: (collected: unknown, reason: string) => void
        ) => {
          if (event === 'end') {
            callback(undefined, 'time')
          }
        },
      }),
    })

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('logs a warning and skips resolution when ambiguous but promptChannel is unavailable (forum parent)', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'ambiguous',
      candidates: ['session-a', 'session-b'],
    })
    const { dependencies, createSessionThread } = makeDependencies()
    dependencies.promptChannel = undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('forum'),
      expect.anything()
    )
    warn.mockRestore()
  })

  // Regression test for a bug found during real-environment integration
  // testing (Issue #13): a Claude Code session running under workspaceRoots
  // with a config dir not listed in `configDirs` makes
  // resolveContainerConfigDirectory throw. Since `runDetectionCycle`
  // previously awaited all panes via `Promise.all`, that single rejection
  // failed the whole cycle every poll — logged as "Detection cycle failed"
  // forever — even though every other pane in the same cycle had already
  // been processed successfully.
  it('does not let one pane throwing prevent other panes in the same cycle from being registered', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([
      { sessionName: 'tmux-1', paneId: '%0', pid: '100' },
      { sessionName: 'tmux-2', paneId: '%1', pid: '101' },
    ])
    vi.mocked(findClaudeProcessPid).mockImplementation((_procRoot, rootPid) =>
      Promise.resolve(rootPid === '100' ? '300' : '301')
    )
    vi.mocked(readProcessEnviron).mockImplementation((_procRoot, pid) =>
      Promise.resolve(
        pid === '300'
          ? { CLAUDE_CONFIG_DIR: '/home/user/.claude' }
          : { CLAUDE_CONFIG_DIR: '/home/other/.claude-work' }
      )
    )
    vi.mocked(resolveContainerConfigDirectory).mockImplementation(
      (_config, hostConfigDirectory) => {
        if (hostConfigDirectory === '/home/other/.claude-work') {
          throw new Error(
            'No configDirs mapping for host path: /home/other/.claude-work'
          )
        }
        return '/host/claude-config'
      }
    )
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      runDetectionCycle(dependencies, makeConfig())
    ).resolves.toBeUndefined()

    expect(createSessionThread).toHaveBeenCalledWith('session-1')
    error.mockRestore()
  })
})
