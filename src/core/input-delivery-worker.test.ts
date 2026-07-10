import { describe, expect, it, vi } from 'vitest'
import { openRegistryDb } from '../registry/db'
import { insertSession, type SessionRow } from '../registry/sessions'
import { insertPendingInput } from '../registry/input-queue'
import type { ExecFunction } from '../tmux/list-sessions'
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
    cwd: '/mnt/ssd/repos/example',
    configDir: '/host/claude-config',
    jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    jsonlOffset: 0,
    status: 'discovered',
    threadNameSource: 'fallback',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeDependencies(exec: ExecFunction): InputDeliveryDependencies {
  return {
    db: openRegistryDb(':memory:'),
    exec,
    socketPath: '/tmp/tmux-host/default',
  }
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
