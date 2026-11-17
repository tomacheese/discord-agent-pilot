import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Config } from '../config/schema'
import { openRegistryDb } from '../registry/db'
import { insertPendingInput } from '../registry/input-queue'
import {
  findSessionById,
  insertSession,
  type SessionRow,
} from '../registry/sessions'
import { AmbiguityTracker } from './ambiguity'
import {
  runDetectionCycle,
  type OrchestratorDependencies,
} from './orchestrator'
import { ThreadStatusTracker } from './thread-status-tracker'

vi.mock('../tmux/list-sessions', () => ({
  listAllTmuxPanes: vi.fn(),
}))
vi.mock('../tmux/process-tree', () => ({
  findClaudeProcessPid: vi.fn(),
  isClaudeProcessIdentityAlive: vi.fn(),
}))
vi.mock('../tmux/proc', () => ({
  readProcessCwd: vi.fn(),
  readProcessEnviron: vi.fn(),
  readProcessStartTicks: vi.fn(),
}))
vi.mock('../tmux/session-id-resolver', () => ({
  resolveContainerConfigDirectory: vi.fn(),
  resolveSessionId: vi.fn(),
}))

import { listAllTmuxPanes } from '../tmux/list-sessions'
import {
  findClaudeProcessPid,
  isClaudeProcessIdentityAlive,
} from '../tmux/process-tree'
import {
  readProcessCwd,
  readProcessEnviron,
  readProcessStartTicks,
} from '../tmux/proc'
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
    registeringSessionIds: new Set(),
    statusTracker: new ThreadStatusTracker(),
  }
  return { dependencies, createSessionThread, promptSend }
}

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    threadId: 'thread-1',
    parentChannelId: 'channel-1',
    tmuxSession: 'tmux-1',
    tmuxPanePid: '100',
    tmuxPaneId: '%0',
    claudePid: '',
    claudeStartTicks: 0,
    cwd: '/mnt/ssd/repos/example',
    configDir: '/host/claude-config',
    jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    jsonlOffset: 0,
    status: 'discovered',
    threadNameSource: 'fallback',
    lastActionSummary: '',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(listAllTmuxPanes)
    .mockReset()
    .mockResolvedValue([{ sessionName: 'tmux-1', paneId: '%0', pid: '100' }])
  vi.mocked(findClaudeProcessPid).mockReset().mockResolvedValue('300')
  vi.mocked(isClaudeProcessIdentityAlive).mockReset().mockResolvedValue(true)
  vi.mocked(readProcessStartTicks).mockReset().mockResolvedValue(5000)
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
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).toHaveBeenCalledWith('example (tmux-1)')
    expect(findSessionById(dependencies.db, 'session-1')).toBeDefined()
  })

  it('stores the pane paneId from listAllTmuxPanes as tmuxPaneId on the session row', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([
      { sessionName: 'tmux-1', paneId: '%7', pid: '100' },
    ])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.tmuxPaneId).toBe('%7')
  })

  it('uses the jsonlPath returned by resolveSessionId as-is, without reconstructing it from cwd', async () => {
    // Regression test for Issue #16: orchestrator.ts must not rebuild
    // jsonlPath from cwd itself (that reconstruction can drift from the
    // real file when cwd changes after session start, e.g. a worktree
    // switch) — it must trust whatever path resolveSessionId verified.
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/some-other-dir/session-1.jsonl',
    })
    const { dependencies } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.jsonlPath).toBe(
      '/host/claude-config/projects/some-other-dir/session-1.jsonl'
    )
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
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
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
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('skips the resolution pipeline for a pane whose bound claude process identity is still alive', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-2',
      jsonlPath: '/host/claude-config/projects/x/session-2.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )

    await runDetectionCycle(dependencies, makeConfig())

    expect(isClaudeProcessIdentityAlive).toHaveBeenCalledWith(
      '/proc',
      '300',
      5000
    )
    expect(findClaudeProcessPid).not.toHaveBeenCalled()
    expect(resolveSessionId).not.toHaveBeenCalled()
    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('re-runs resolution when the process bound to the pane exited and a new claude started', async () => {
    vi.mocked(isClaudeProcessIdentityAlive).mockResolvedValue(false)
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-2',
      jsonlPath: '/host/claude-config/projects/x/session-2.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )

    await runDetectionCycle(dependencies, makeConfig())

    expect(findClaudeProcessPid).toHaveBeenCalledWith('/proc', '100')
    expect(createSessionThread).toHaveBeenCalledWith('example (tmux-1)')
    expect(findSessionById(dependencies.db, 'session-2')).toBeDefined()
  })

  it('records the pid and start ticks of the claude process on a newly registered session', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies } = makeDependencies()

    await runDetectionCycle(dependencies, makeConfig())

    const row = findSessionById(dependencies.db, 'session-1')
    expect(row?.claudePid).toBe('400')
    expect(row?.claudeStartTicks).toBe(8000)
    expect(readProcessStartTicks).toHaveBeenCalledWith('/proc', '400')
  })

  it.each([
    [
      'the process exits before its start time is read (ENOENT)',
      () =>
        vi
          .mocked(readProcessStartTicks)
          .mockRejectedValue(
            Object.assign(new Error('gone'), { code: 'ENOENT' })
          ),
    ],
    [
      'the stat file is malformed (NaN)',
      () => vi.mocked(readProcessStartTicks).mockResolvedValue(NaN),
    ],
  ])(
    'skips the pane for this cycle without writing anything when %s',
    async (_name, arrange) => {
      arrange()
      vi.mocked(resolveSessionId).mockResolvedValue({
        kind: 'resolved',
        sessionId: 'session-1',
        jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
      })
      const { dependencies, createSessionThread } = makeDependencies()

      await expect(
        runDetectionCycle(dependencies, makeConfig())
      ).resolves.toBeUndefined()

      expect(createSessionThread).not.toHaveBeenCalled()
      expect(findSessionById(dependencies.db, 'session-1')).toBeUndefined()
    }
  )

  it('prompts for a selection when resolution is ambiguous, then registers the chosen sessionId and its jsonlPath', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'ambiguous',
      candidates: [
        {
          sessionId: 'session-a',
          jsonlPath: '/host/claude-config/projects/x/session-a.jsonl',
        },
        {
          sessionId: 'session-b',
          jsonlPath: '/host/claude-config/projects/y/session-b.jsonl',
        },
      ],
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

    expect(createSessionThread).toHaveBeenCalledWith('example (tmux-1)')
    const row = findSessionById(dependencies.db, 'session-b')
    expect(row).toBeDefined()
    expect(row?.jsonlPath).toBe(
      '/host/claude-config/projects/y/session-b.jsonl'
    )
  })

  it('does not register a session when the ambiguity prompt times out', async () => {
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'ambiguous',
      candidates: [
        {
          sessionId: 'session-a',
          jsonlPath: '/host/claude-config/projects/x/session-a.jsonl',
        },
        {
          sessionId: 'session-b',
          jsonlPath: '/host/claude-config/projects/y/session-b.jsonl',
        },
      ],
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
      candidates: [
        {
          sessionId: 'session-a',
          jsonlPath: '/host/claude-config/projects/x/session-a.jsonl',
        },
        {
          sessionId: 'session-b',
          jsonlPath: '/host/claude-config/projects/y/session-b.jsonl',
        },
      ],
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
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      runDetectionCycle(dependencies, makeConfig())
    ).resolves.toBeUndefined()

    expect(createSessionThread).toHaveBeenCalledWith('example (tmux-1)')
    error.mockRestore()
  })
})

/** Marks only the given pid/start-ticks pairs as live claude process identities. */
function aliveIdentities(...alive: [string, number][]): void {
  vi.mocked(isClaudeProcessIdentityAlive).mockImplementation(
    (_procRoot, pid, startTicks) =>
      Promise.resolve(
        alive.some(([p, ticks]) => p === pid && ticks === startTicks)
      )
  )
}

function stateOfInput(
  dependencies: OrchestratorDependencies,
  id: number
): string {
  return (
    dependencies.db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(id) as { state: string }
  ).state
}

describe('session process identity', () => {
  it('closes the previous session of a pane when a new session is registered there, leaving other panes alone', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    aliveIdentities(['400', 8000], ['301', 6000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-2',
      jsonlPath: '/host/claude-config/projects/x/session-2.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    createSessionThread.mockResolvedValue({ id: 'thread-2' })
    const archiveThread = vi.fn().mockResolvedValue(undefined)
    dependencies.parentChannel.archiveThread = archiveThread
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )
    insertSession(
      dependencies.db,
      makeSessionRow({
        id: 'session-3',
        threadId: 'thread-3',
        tmuxPaneId: '%1',
        claudePid: '301',
        claudeStartTicks: 6000,
      })
    )

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe('closed')
    expect(findSessionById(dependencies.db, 'session-2')?.status).toBe(
      'discovered'
    )
    expect(findSessionById(dependencies.db, 'session-3')?.status).toBe(
      'discovered'
    )
    expect(archiveThread).toHaveBeenCalledTimes(1)
    expect(archiveThread).toHaveBeenCalledWith('thread-1')
  })

  it('closes every other open session of the pane even when archiving one of them fails', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    aliveIdentities(['400', 8000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-2',
      jsonlPath: '/host/claude-config/projects/x/session-2.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    createSessionThread.mockResolvedValue({ id: 'thread-2' })
    const archiveThread = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discord API error'))
      .mockResolvedValue(undefined)
    dependencies.parentChannel.archiveThread = archiveThread
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )
    insertSession(
      dependencies.db,
      makeSessionRow({
        id: 'session-0',
        threadId: 'thread-0',
        claudePid: '200',
        claudeStartTicks: 4000,
      })
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe('closed')
    expect(findSessionById(dependencies.db, 'session-0')?.status).toBe('closed')
    expect(archiveThread).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('reopens a closed session resumed in the same pane, keeping its thread and offset', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    aliveIdentities(['400', 8000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    const unarchiveThread = vi.fn().mockResolvedValue(undefined)
    dependencies.parentChannel.unarchiveThread = unarchiveThread
    insertSession(
      dependencies.db,
      makeSessionRow({
        status: 'closed',
        jsonlOffset: 500,
        claudePid: '300',
        claudeStartTicks: 5000,
      })
    )

    await runDetectionCycle(dependencies, makeConfig())

    const row = findSessionById(dependencies.db, 'session-1')
    expect(row?.status).toBe('discovered')
    expect(row?.threadId).toBe('thread-1')
    expect(row?.jsonlOffset).toBe(500)
    expect(row?.tmuxPaneId).toBe('%0')
    expect(row?.claudePid).toBe('400')
    expect(row?.claudeStartTicks).toBe(8000)
    expect(createSessionThread).not.toHaveBeenCalled()
    expect(unarchiveThread).toHaveBeenCalledTimes(1)
    expect(unarchiveThread).toHaveBeenCalledWith('thread-1')
  })

  it('reopens a closed session resumed in a different pane and binds it to that pane', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([
      { sessionName: 'tmux-9', paneId: '%9', pid: '900' },
    ])
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    aliveIdentities(['400', 8000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    insertSession(
      dependencies.db,
      makeSessionRow({
        status: 'closed',
        claudePid: '300',
        claudeStartTicks: 5000,
      })
    )

    await runDetectionCycle(dependencies, makeConfig())

    const row = findSessionById(dependencies.db, 'session-1')
    expect(row?.status).toBe('discovered')
    expect(row?.tmuxSession).toBe('tmux-9')
    expect(row?.tmuxPanePid).toBe('900')
    expect(row?.tmuxPaneId).toBe('%9')
    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('rebinds a still-open session to its new process without unarchiving its thread', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    aliveIdentities(['400', 8000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies } = makeDependencies()
    const unarchiveThread = vi.fn().mockResolvedValue(undefined)
    dependencies.parentChannel.unarchiveThread = unarchiveThread
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )

    await runDetectionCycle(dependencies, makeConfig())

    const row = findSessionById(dependencies.db, 'session-1')
    expect(row?.status).toBe('discovered')
    expect(row?.claudePid).toBe('400')
    expect(unarchiveThread).not.toHaveBeenCalled()
  })

  it('still reopens the session when unarchiving its thread fails', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    aliveIdentities(['400', 8000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies } = makeDependencies()
    dependencies.parentChannel.unarchiveThread = vi
      .fn()
      .mockRejectedValue(new Error('Discord API error'))
    insertSession(dependencies.db, makeSessionRow({ status: 'closed' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe(
      'discovered'
    )
    error.mockRestore()
  })

  it('adopts an identity for a legacy open row instead of skipping its pane', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('300')
    vi.mocked(readProcessStartTicks).mockResolvedValue(5000)
    aliveIdentities(['300', 5000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-1',
      jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    insertSession(dependencies.db, makeSessionRow())

    await runDetectionCycle(dependencies, makeConfig())

    expect(resolveSessionId).toHaveBeenCalled()
    const row = findSessionById(dependencies.db, 'session-1')
    expect(row?.status).toBe('discovered')
    expect(row?.claudePid).toBe('300')
    expect(row?.claudeStartTicks).toBe(5000)
    expect(createSessionThread).not.toHaveBeenCalled()
  })

  it('closes a session whose bound process is gone even though another claude runs in its pane', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    aliveIdentities()
    const { dependencies } = makeDependencies()
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe('closed')
  })

  it('keeps a session open while its bound process identity is alive', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue(undefined)
    aliveIdentities(['300', 5000])
    const { dependencies } = makeDependencies()
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe(
      'discovered'
    )
  })

  it('fails the pending input of a session when it closes, leaving other sessions untouched', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    aliveIdentities(['301', 6000])
    const { dependencies } = makeDependencies()
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )
    insertSession(
      dependencies.db,
      makeSessionRow({
        id: 'session-3',
        threadId: 'thread-3',
        tmuxPaneId: '%1',
        claudePid: '301',
        claudeStartTicks: 6000,
      })
    )
    const closedPending = insertPendingInput(
      dependencies.db,
      'session-1',
      'discord',
      'queued before exit'
    )
    const otherPending = insertPendingInput(
      dependencies.db,
      'session-3',
      'discord',
      'for the live session'
    )

    await runDetectionCycle(dependencies, makeConfig())

    expect(stateOfInput(dependencies, closedPending)).toBe('failed')
    expect(stateOfInput(dependencies, otherPending)).toBe('pending')
  })

  it('fails the pending input of a session closed because a new session replaced it in the pane', async () => {
    vi.mocked(findClaudeProcessPid).mockResolvedValue('400')
    vi.mocked(readProcessStartTicks).mockResolvedValue(8000)
    aliveIdentities(['400', 8000])
    vi.mocked(resolveSessionId).mockResolvedValue({
      kind: 'resolved',
      sessionId: 'session-2',
      jsonlPath: '/host/claude-config/projects/x/session-2.jsonl',
    })
    const { dependencies, createSessionThread } = makeDependencies()
    createSessionThread.mockResolvedValue({ id: 'thread-2' })
    insertSession(
      dependencies.db,
      makeSessionRow({ claudePid: '300', claudeStartTicks: 5000 })
    )
    const pending = insertPendingInput(
      dependencies.db,
      'session-1',
      'discord',
      'queued for the old process'
    )

    await runDetectionCycle(dependencies, makeConfig())

    expect(stateOfInput(dependencies, pending)).toBe('failed')
  })
})

describe('closing exited sessions', () => {
  it('marks a session closed when its Claude process has exited', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue(undefined)
    const { dependencies } = makeDependencies()
    insertSession(dependencies.db, makeSessionRow())

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe('closed')
  })

  it('leaves a session open when its Claude process is still alive', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue('300')
    const { dependencies } = makeDependencies()
    insertSession(dependencies.db, makeSessionRow())

    await runDetectionCycle(dependencies, makeConfig())

    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe(
      'discovered'
    )
  })

  it('archives the Discord thread for a forum parent channel when a session closes', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue(undefined)
    const { dependencies } = makeDependencies()
    const archiveThread = vi.fn().mockResolvedValue(undefined)
    dependencies.parentChannel.archiveThread = archiveThread
    insertSession(dependencies.db, makeSessionRow())

    await runDetectionCycle(dependencies, makeConfig())

    expect(archiveThread).toHaveBeenCalledWith('thread-1')
  })

  it('does not call archiveThread when the parent channel type is text', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue(undefined)
    const { dependencies } = makeDependencies()
    const archiveThread = vi.fn()
    dependencies.parentChannel.archiveThread = archiveThread
    insertSession(dependencies.db, makeSessionRow())
    const config = makeConfig()
    config.parentChannel = { type: 'text', id: 'channel-1' }

    await runDetectionCycle(dependencies, config)

    expect(archiveThread).not.toHaveBeenCalled()
    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe('closed')
  })

  it('still marks the session closed and does not throw when archiveThread rejects', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue(undefined)
    const { dependencies } = makeDependencies()
    dependencies.parentChannel.archiveThread = vi
      .fn()
      .mockRejectedValue(new Error('Discord API error'))
    insertSession(dependencies.db, makeSessionRow())

    await expect(
      runDetectionCycle(dependencies, makeConfig())
    ).resolves.not.toThrow()
    expect(findSessionById(dependencies.db, 'session-1')?.status).toBe('closed')
  })
})

describe('updating thread statuses', () => {
  it('updates the starter message for an open session in a forum parent channel', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue('300')
    const { dependencies } = makeDependencies()
    const updateThreadStatus = vi.fn().mockResolvedValue(undefined)
    dependencies.parentChannel.updateThreadStatus = updateThreadStatus
    insertSession(dependencies.db, makeSessionRow())

    await runDetectionCycle(dependencies, makeConfig())

    expect(updateThreadStatus).toHaveBeenCalledWith(
      'thread-1',
      expect.stringContaining('実行中')
    )
  })

  it('does not check liveness or update the starter message for a text parent channel', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue('300')
    const { dependencies } = makeDependencies()
    const updateThreadStatus = vi.fn()
    dependencies.parentChannel.updateThreadStatus = updateThreadStatus
    insertSession(dependencies.db, makeSessionRow())
    const config = makeConfig()
    config.parentChannel = { type: 'text', id: 'channel-1' }

    await runDetectionCycle(dependencies, config)

    expect(updateThreadStatus).not.toHaveBeenCalled()
  })

  it('does not update the starter message for a closed session', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue(undefined)
    const { dependencies } = makeDependencies()
    const updateThreadStatus = vi.fn()
    dependencies.parentChannel.updateThreadStatus = updateThreadStatus
    insertSession(dependencies.db, makeSessionRow({ status: 'closed' }))

    await runDetectionCycle(dependencies, makeConfig())

    expect(updateThreadStatus).not.toHaveBeenCalled()
  })

  it('does not re-update the starter message when the status tracker reports no change', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue('300')
    const { dependencies } = makeDependencies()
    const updateThreadStatus = vi.fn().mockResolvedValue(undefined)
    dependencies.parentChannel.updateThreadStatus = updateThreadStatus
    insertSession(dependencies.db, makeSessionRow())

    await runDetectionCycle(dependencies, makeConfig())
    await runDetectionCycle(dependencies, makeConfig())

    expect(updateThreadStatus).toHaveBeenCalledTimes(1)
  })

  it('continues updating other sessions when one updateThreadStatus call rejects', async () => {
    vi.mocked(listAllTmuxPanes).mockResolvedValue([])
    vi.mocked(findClaudeProcessPid).mockResolvedValue('300')
    const { dependencies } = makeDependencies()
    const updateThreadStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discord API error'))
      .mockResolvedValueOnce(undefined)
    dependencies.parentChannel.updateThreadStatus = updateThreadStatus
    insertSession(
      dependencies.db,
      makeSessionRow({ id: 'session-1', threadId: 'thread-1' })
    )
    insertSession(
      dependencies.db,
      makeSessionRow({ id: 'session-2', threadId: 'thread-2' })
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      runDetectionCycle(dependencies, makeConfig())
    ).resolves.not.toThrow()

    expect(updateThreadStatus).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})
