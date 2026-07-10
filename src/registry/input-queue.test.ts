import { describe, expect, it } from 'vitest'
import { openRegistryDb } from './db'
import { insertSession, type SessionRow } from './sessions'
import {
  findOldestPendingInput,
  findSessionIdsWithPendingInput,
  insertPendingInput,
  resetStaleSendingInputs,
  updateInputQueueState,
} from './input-queue'

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    threadId: 'thread-1',
    parentChannelId: 'channel-1',
    tmuxSession: 'tmux-1',
    tmuxPanePid: '1234',
    tmuxPaneId: '%0',
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

describe('insertPendingInput / findOldestPendingInput', () => {
  it('inserts a row in "pending" state and returns its id', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())

    const id = insertPendingInput(db, 'session-1', 'discord', 'hello')

    expect(typeof id).toBe('number')
    expect(findOldestPendingInput(db, 'session-1')).toEqual({
      id,
      body: 'hello',
    })
  })

  it('returns the oldest pending row first (FIFO)', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())
    const firstId = insertPendingInput(db, 'session-1', 'discord', 'first')
    insertPendingInput(db, 'session-1', 'discord', 'second')

    expect(findOldestPendingInput(db, 'session-1')).toEqual({
      id: firstId,
      body: 'first',
    })
  })

  it('returns undefined when there is no pending row for the session', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())

    expect(findOldestPendingInput(db, 'session-1')).toBeUndefined()
  })

  it('ignores rows already moved past pending state', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())
    const id = insertPendingInput(db, 'session-1', 'discord', 'hello')
    updateInputQueueState(db, id, 'sent')

    expect(findOldestPendingInput(db, 'session-1')).toBeUndefined()
  })
})

describe('updateInputQueueState', () => {
  it('transitions a row through pending -> sending -> sent', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())
    const id = insertPendingInput(db, 'session-1', 'discord', 'hello')

    updateInputQueueState(db, id, 'sending')
    const stateAfterSending = db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(id) as { state: string }
    expect(stateAfterSending.state).toBe('sending')

    updateInputQueueState(db, id, 'sent')
    const stateAfterSent = db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(id) as { state: string }
    expect(stateAfterSent.state).toBe('sent')
  })
})

describe('resetStaleSendingInputs', () => {
  it('moves rows stuck in "sending" to "failed"', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())
    const id = insertPendingInput(db, 'session-1', 'discord', 'hello')
    updateInputQueueState(db, id, 'sending')

    resetStaleSendingInputs(db)

    const row = db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(id) as { state: string }
    expect(row.state).toBe('failed')
  })

  it('does not touch rows already in pending, sent, or failed state', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())
    const pendingId = insertPendingInput(db, 'session-1', 'discord', 'a')
    const sentId = insertPendingInput(db, 'session-1', 'discord', 'b')
    updateInputQueueState(db, sentId, 'sent')

    resetStaleSendingInputs(db)

    const pendingRow = db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(pendingId) as { state: string }
    const sentRow = db
      .prepare('SELECT state FROM input_queue WHERE id = ?')
      .get(sentId) as { state: string }
    expect(pendingRow.state).toBe('pending')
    expect(sentRow.state).toBe('sent')
  })
})

describe('findSessionIdsWithPendingInput', () => {
  it('returns the distinct sessionIds that have at least one pending row', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())
    insertSession(db, makeSessionRow({ id: 'session-2', threadId: 'thread-2' }))
    insertPendingInput(db, 'session-1', 'discord', 'a')
    insertPendingInput(db, 'session-1', 'discord', 'b')
    insertPendingInput(db, 'session-2', 'discord', 'c')

    expect(findSessionIdsWithPendingInput(db).toSorted()).toEqual([
      'session-1',
      'session-2',
    ])
  })

  it('returns an empty array when no session has a pending row', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeSessionRow())

    expect(findSessionIdsWithPendingInput(db)).toEqual([])
  })
})
