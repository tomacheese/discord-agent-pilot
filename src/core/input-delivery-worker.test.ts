import { describe, expect, it, vi } from 'vitest'
import { openRegistryDb } from '../registry/db'
import {
  insertSession,
  markSessionClosed,
  type SessionRow,
} from '../registry/sessions'
import { insertPendingInput } from '../registry/input-queue'
import type { ExecFunction } from '../tmux/list-sessions'
import { makeFakeProcRoot, writeFakeProcess } from '../test-utils/fake-proc'
import { waitFor } from '../test-utils/wait-for'
import {
  triggerInputDelivery,
  type InputDeliveryDependencies,
} from './input-delivery-worker'

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    threadId: 'thread-1',
    parentChannelId: 'channel-1',
    tmuxSession: 'tmux-1',
    tmuxPanePid: '1234',
    tmuxPaneId: '%7',
    claudePid: '300',
    claudeStartTicks: 5000,
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

/** Dependencies whose fake `/proc` hosts the live claude process (pid 300) of the default session row. */
function makeDependencies(exec: ExecFunction): InputDeliveryDependencies {
  const procRoot = makeFakeProcRoot()
  writeFakeProcess(procRoot, '300', { comm: 'claude', startTicks: 5000 })
  return {
    db: openRegistryDb(':memory:'),
    exec,
    socketPath: '/tmp/tmux-host/default',
    procRoot,
  }
}

function stateOf(dependencies: InputDeliveryDependencies, id: number): string {
  return (
    dependencies.db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(id) as { state: string }
  ).state
}

function pastedBodies(exec: ReturnType<typeof vi.fn<ExecFunction>>): string[] {
  return exec.mock.calls
    .filter((call) => call[1][0] === 'set-buffer')
    .map((call) => call[1].at(-1) ?? '')
}

describe('triggerInputDelivery', () => {
  it('delivers a single pending row and marks it sent', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())
    const id = insertPendingInput(dependencies.db, 'session-1', 'discord', 'hi')

    triggerInputDelivery(dependencies, 'session-1')

    await waitFor(() => {
      const row = dependencies.db
        .prepare('SELECT state FROM input_queue WHERE id = ?')
        .get(id) as { state: string }
      return row.state === 'sent'
    })
    expect(exec).toHaveBeenCalledWith('/tmp/tmux-host/default', [
      'send-keys',
      '-t',
      '%7',
      'Enter',
    ])
  })

  it('delivers multiple pending rows for the same session in order', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())
    insertPendingInput(dependencies.db, 'session-1', 'discord', 'first')
    insertPendingInput(dependencies.db, 'session-1', 'discord', 'second')

    triggerInputDelivery(dependencies, 'session-1')

    await waitFor(() => {
      const rows = dependencies.db
        .prepare('SELECT state FROM input_queue')
        .all() as { state: string }[]
      return rows.every((row) => row.state === 'sent')
    })
    const bufferCalls = exec.mock.calls.filter(
      (call) => call[1][0] === 'set-buffer'
    )
    expect(bufferCalls[0][1]).toContain('first')
    expect(bufferCalls[1][1]).toContain('second')
  })

  it('marks the row failed and continues to the next row when tmux delivery throws', async () => {
    const exec = vi
      .fn<ExecFunction>()
      .mockRejectedValueOnce(new Error('tmux boom'))
      .mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())
    const firstId = insertPendingInput(
      dependencies.db,
      'session-1',
      'discord',
      'first'
    )
    const secondId = insertPendingInput(
      dependencies.db,
      'session-1',
      'discord',
      'second'
    )

    triggerInputDelivery(dependencies, 'session-1')

    await waitFor(() => {
      const row = dependencies.db
        .prepare('SELECT state FROM input_queue WHERE id = ?')
        .get(secondId) as { state: string }
      return row.state === 'sent'
    })
    const failedRow = dependencies.db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(firstId) as { state: string }
    expect(failedRow.state).toBe('failed')
  })

  it('marks the row failed without calling tmux when tmuxPaneId is empty', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow({ tmuxPaneId: '' }))
    const id = insertPendingInput(dependencies.db, 'session-1', 'discord', 'hi')

    triggerInputDelivery(dependencies, 'session-1')

    await waitFor(() => {
      const row = dependencies.db
        .prepare('SELECT state FROM input_queue WHERE id = ?')
        .get(id) as { state: string }
      return row.state === 'failed'
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('marks a pending row for a closed session failed without calling tmux (startup backlog sweep)', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow({ status: 'closed' }))
    const id = insertPendingInput(dependencies.db, 'session-1', 'discord', 'hi')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    triggerInputDelivery(dependencies, 'session-1')

    await waitFor(() => stateOf(dependencies, id) === 'failed')
    expect(exec).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      `Session session-1 is closed; marking input_queue row ${id} as failed`
    )
    error.mockRestore()
  })

  it('marks a pending row failed without calling tmux when the session row no longer exists', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())
    const id = insertPendingInput(dependencies.db, 'session-1', 'discord', 'hi')
    dependencies.db.pragma('foreign_keys = OFF')
    dependencies.db
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run('session-1')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    triggerInputDelivery(dependencies, 'session-1')

    await waitFor(() => stateOf(dependencies, id) === 'failed')
    expect(exec).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      `Session session-1 not found; marking input_queue row ${id} as failed`
    )
    error.mockRestore()
  })

  it.each([
    {
      name: 'its pid now runs a different command',
      claudePid: '300',
      arrange: (procRoot: string) => {
        writeFakeProcess(procRoot, '300', { comm: 'bash', startTicks: 5000 })
      },
    },
    {
      name: 'its pid was reused by another claude process (start ticks differ)',
      claudePid: '300',
      arrange: (procRoot: string) => {
        writeFakeProcess(procRoot, '300', { comm: 'claude', startTicks: 9000 })
      },
    },
    {
      name: 'its process no longer exists',
      claudePid: '302',
      arrange: () => undefined,
    },
  ])(
    'marks a pending row failed without calling tmux when the bound process identity is dead: $name',
    async ({ claudePid, arrange }) => {
      const exec = vi.fn<ExecFunction>().mockResolvedValue('')
      const dependencies = makeDependencies(exec)
      arrange(dependencies.procRoot)
      insertSession(dependencies.db, makeSessionRow({ claudePid }))
      const id = insertPendingInput(
        dependencies.db,
        'session-1',
        'discord',
        'hi'
      )
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)

      triggerInputDelivery(dependencies, 'session-1')

      await waitFor(() => stateOf(dependencies, id) === 'failed')
      expect(exec).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(
        `Claude process bound to session session-1 is not running; marking input_queue row ${id} as failed`
      )
      error.mockRestore()
    }
  )

  it('fails the remaining rows of a drain loop when the session closes while the loop is running', async () => {
    const dependenciesHolder: { current?: InputDeliveryDependencies } = {}
    const exec = vi.fn<ExecFunction>().mockImplementation(() => {
      if (dependenciesHolder.current) {
        markSessionClosed(dependenciesHolder.current.db, 'session-1')
      }
      return Promise.resolve('')
    })
    const dependencies = makeDependencies(exec)
    dependenciesHolder.current = dependencies
    insertSession(dependencies.db, makeSessionRow())
    const firstId = insertPendingInput(
      dependencies.db,
      'session-1',
      'discord',
      'first'
    )
    const secondId = insertPendingInput(
      dependencies.db,
      'session-1',
      'discord',
      'second'
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    triggerInputDelivery(dependencies, 'session-1')

    await waitFor(() => stateOf(dependencies, secondId) === 'failed')
    expect(stateOf(dependencies, firstId)).toBe('sent')
    expect(pastedBodies(exec)).toEqual(['first'])
    error.mockRestore()
  })

  it('never delivers input queued for a replaced session into the pane of the new session', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    // The original process (pid 300) is gone; a new claude (pid 400) now
    // runs in the same pane and backs session-2.
    writeFakeProcess(dependencies.procRoot, '300', {
      comm: 'bash',
      startTicks: 5000,
    })
    writeFakeProcess(dependencies.procRoot, '400', {
      comm: 'claude',
      startTicks: 8000,
    })
    insertSession(dependencies.db, makeSessionRow())
    insertSession(
      dependencies.db,
      makeSessionRow({
        id: 'session-2',
        threadId: 'thread-2',
        claudePid: '400',
        claudeStartTicks: 8000,
      })
    )
    const staleId = insertPendingInput(
      dependencies.db,
      'session-1',
      'discord',
      'for the old process'
    )
    const currentId = insertPendingInput(
      dependencies.db,
      'session-2',
      'discord',
      'for the new process'
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    triggerInputDelivery(dependencies, 'session-1')
    triggerInputDelivery(dependencies, 'session-2')

    await waitFor(
      () =>
        stateOf(dependencies, staleId) === 'failed' &&
        stateOf(dependencies, currentId) === 'sent'
    )
    expect(pastedBodies(exec)).toEqual(['for the new process'])
    error.mockRestore()
  })

  it('does not start a second concurrent delivery loop for the same session', async () => {
    let resolveFirstExec: (() => void) | undefined
    const exec = vi.fn<ExecFunction>().mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveFirstExec = () => {
            resolve('')
          }
        })
    )
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())
    insertPendingInput(dependencies.db, 'session-1', 'discord', 'first')

    triggerInputDelivery(dependencies, 'session-1')
    await waitFor(() => exec.mock.calls.length === 1)
    triggerInputDelivery(dependencies, 'session-1')
    // Give a re-entrant loop a chance to start if the guard were broken.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(exec).toHaveBeenCalledTimes(1)
    resolveFirstExec?.()
  })
})
