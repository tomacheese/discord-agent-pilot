import { describe, expect, it, vi } from 'vitest'
import { openRegistryDb } from '../registry/db'
import { insertSession, type SessionRow } from '../registry/sessions'
import type { ExecFunction } from '../tmux/list-sessions'
import type { InputDeliveryDependencies } from './input-delivery-worker'
import { waitFor } from '../test-utils/wait-for'
import { handleAllowedMessage } from './allowed-message-handler'

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

describe('handleAllowedMessage', () => {
  it('does not queue when no session matches the threadId', () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)

    handleAllowedMessage(dependencies, 'unknown-thread', 'hi')

    const rows = dependencies.db.prepare('SELECT * FROM input_queue').all()
    expect(rows).toHaveLength(0)
    expect(exec).not.toHaveBeenCalled()
  })

  it('does not queue when the matching session is closed', () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow({ status: 'closed' }))

    handleAllowedMessage(dependencies, 'thread-1', 'hi')

    const rows = dependencies.db.prepare('SELECT * FROM input_queue').all()
    expect(rows).toHaveLength(0)
    expect(exec).not.toHaveBeenCalled()
  })

  it('does not queue whitespace-only content', () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())

    handleAllowedMessage(dependencies, 'thread-1', ' '.repeat(3))

    const rows = dependencies.db.prepare('SELECT * FROM input_queue').all()
    expect(rows).toHaveLength(0)
    expect(exec).not.toHaveBeenCalled()
  })

  it('does not queue empty content', () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())

    handleAllowedMessage(dependencies, 'thread-1', '')

    const rows = dependencies.db.prepare('SELECT * FROM input_queue').all()
    expect(rows).toHaveLength(0)
    expect(exec).not.toHaveBeenCalled()
  })

  it('queues non-empty content and triggers delivery', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')
    const dependencies = makeDependencies(exec)
    insertSession(dependencies.db, makeSessionRow())

    handleAllowedMessage(dependencies, 'thread-1', 'hello')

    const rows = dependencies.db
      .prepare('SELECT body, state FROM input_queue')
      .all() as { body: string; state: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toBe('hello')

    await waitFor(() => {
      const row = dependencies.db
        .prepare('SELECT state FROM input_queue LIMIT 1')
        .get() as { state: string }
      return row.state === 'sent'
    })
  })
})
