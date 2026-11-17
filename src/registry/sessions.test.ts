import { describe, expect, it } from 'vitest'
import { openRegistryDb } from './db'
import {
  findOpenSessions,
  findSessionById,
  findSessionByThreadId,
  getThreadNameSource,
  hasTmuxPane,
  insertSession,
  findOpenSessionsByPaneId,
  markSessionClosed,
  rebindSession,
  updateJsonlPath,
  updateLastActionSummary,
  updateThreadNameSource,
  type SessionRow,
} from './sessions'

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    threadId: 'thread-1',
    parentChannelId: 'channel-1',
    tmuxSession: 'tmux-1',
    tmuxPanePid: '1234',
    tmuxPaneId: '%0',
    claudePid: '',
    claudeStartTicks: 0,
    cwd: '/mnt/ssd/repos/example',
    configDir: '/host/claude-config',
    jsonlPath:
      '/host/claude-config/projects/-mnt-ssd-repos-example/session-1.jsonl',
    jsonlOffset: 0,
    status: 'discovered',
    threadNameSource: 'fallback',
    lastActionSummary: '',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('sessions registry', () => {
  it('returns undefined for an unknown sessionId', () => {
    const db = openRegistryDb(':memory:')
    expect(findSessionById(db, 'unknown')).toBeUndefined()
  })

  it('inserts and retrieves a session row', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())
    const found = findSessionById(db, 'session-1')
    expect(found).toEqual(makeRow())
  })

  it('throws when inserting a duplicate id', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())
    expect(() => {
      insertSession(db, makeRow())
    }).toThrow()
  })
})

describe('claude process identity', () => {
  it('round-trips claudePid and claudeStartTicks through insert and find', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow({ claudePid: '4321', claudeStartTicks: 987_654 }))

    const found = findSessionById(db, 'session-1')

    expect(found?.claudePid).toBe('4321')
    expect(found?.claudeStartTicks).toBe(987_654)
  })
})

describe('findOpenSessionsByPaneId', () => {
  it('returns only open rows bound to the given pane', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow({ id: 'open-same', threadId: 't1' }))
    insertSession(
      db,
      makeRow({ id: 'closed-same', threadId: 't2', status: 'closed' })
    )
    insertSession(
      db,
      makeRow({ id: 'open-other', threadId: 't3', tmuxPaneId: '%9' })
    )

    const rows = findOpenSessionsByPaneId(db, '%0')

    expect(rows.map((row) => row.id)).toEqual(['open-same'])
  })

  it('returns an empty array for an empty pane id even if legacy rows have one', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow({ tmuxPaneId: '' }))

    expect(findOpenSessionsByPaneId(db, '')).toEqual([])
  })
})

describe('rebindSession', () => {
  it('reopens a closed row with the new pane and process identity, keeping thread and offset', () => {
    const db = openRegistryDb(':memory:')
    insertSession(
      db,
      makeRow({
        status: 'closed',
        jsonlOffset: 500,
        claudePid: '100',
        claudeStartTicks: 1,
        updatedAt: 1000,
      })
    )

    rebindSession(db, 'session-1', {
      tmuxSession: 'tmux-2',
      tmuxPanePid: '2222',
      tmuxPaneId: '%5',
      claudePid: '300',
      claudeStartTicks: 42,
    })

    const found = findSessionById(db, 'session-1')
    expect(found?.updatedAt).toBeGreaterThan(1000)
    expect({ ...found, updatedAt: 0 }).toEqual({
      ...makeRow(),
      tmuxSession: 'tmux-2',
      tmuxPanePid: '2222',
      tmuxPaneId: '%5',
      claudePid: '300',
      claudeStartTicks: 42,
      status: 'discovered',
      jsonlOffset: 500,
      updatedAt: 0,
    })
  })

  it('does not affect other sessions', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow({ id: 'session-1', status: 'closed' }))
    insertSession(
      db,
      makeRow({ id: 'session-2', threadId: 'thread-2', status: 'closed' })
    )

    rebindSession(db, 'session-1', {
      tmuxSession: 'tmux-2',
      tmuxPanePid: '2222',
      tmuxPaneId: '%5',
      claudePid: '300',
      claudeStartTicks: 42,
    })

    expect(findSessionById(db, 'session-2')?.status).toBe('closed')
  })
})

describe('thread name source', () => {
  it('defaults to "fallback" for a newly inserted row', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())
    expect(getThreadNameSource(db, 'session-1')).toBe('fallback')
  })

  it('updates and reads back the thread name source', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())
    updateThreadNameSource(db, 'session-1', 'ai-title')
    expect(getThreadNameSource(db, 'session-1')).toBe('ai-title')
    updateThreadNameSource(db, 'session-1', 'agent-name')
    expect(getThreadNameSource(db, 'session-1')).toBe('agent-name')
  })

  it('throws a clear error for an unknown sessionId', () => {
    const db = openRegistryDb(':memory:')
    expect(() => {
      getThreadNameSource(db, 'unknown')
    }).toThrow('No session found for id: unknown')
  })
})

describe('sessions registry', () => {
  it('updates jsonl_path and jsonl_offset to the given offset (0 for an empty target file)', () => {
    const db = openRegistryDb(':memory:')
    insertSession(
      db,
      makeRow({ jsonlPath: '/old/path/session-1.jsonl', jsonlOffset: 500 })
    )

    updateJsonlPath(db, 'session-1', '/new/path/session-1.jsonl', 0)

    const found = findSessionById(db, 'session-1')
    expect(found?.jsonlPath).toBe('/new/path/session-1.jsonl')
    expect(found?.jsonlOffset).toBe(0)
  })

  it('updates jsonl_offset to a nonzero, caller-supplied value (pre-existing target file)', () => {
    const db = openRegistryDb(':memory:')
    insertSession(
      db,
      makeRow({ jsonlPath: '/old/path/session-1.jsonl', jsonlOffset: 500 })
    )

    updateJsonlPath(db, 'session-1', '/new/path/session-1.jsonl', 42)

    const found = findSessionById(db, 'session-1')
    expect(found?.jsonlPath).toBe('/new/path/session-1.jsonl')
    expect(found?.jsonlOffset).toBe(42)
  })
})

describe('updateLastActionSummary', () => {
  it('updates and reads back the last action summary', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())

    updateLastActionSummary(db, 'session-1', '⏺ Bash(ls -la)')

    expect(findSessionById(db, 'session-1')?.lastActionSummary).toBe(
      '⏺ Bash(ls -la)'
    )
  })

  it('does not throw for an unknown sessionId', () => {
    const db = openRegistryDb(':memory:')
    expect(() => {
      updateLastActionSummary(db, 'unknown', 'summary')
    }).not.toThrow()
  })
})

describe('hasTmuxPane', () => {
  it('returns false for an empty tmuxPaneId and true for a real one', () => {
    expect(hasTmuxPane(makeRow({ tmuxPaneId: '' }))).toBe(false)
    expect(hasTmuxPane(makeRow({ tmuxPaneId: '%3' }))).toBe(true)
  })
})

describe('findSessionByThreadId', () => {
  it('returns the session row matching the given threadId', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())
    expect(findSessionByThreadId(db, 'thread-1')).toEqual(makeRow())
  })

  it('returns undefined when no session has the given threadId', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())
    expect(findSessionByThreadId(db, 'unknown-thread')).toBeUndefined()
  })
})

describe('findOpenSessions', () => {
  it('returns only sessions whose status is not "closed"', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow({ id: 'session-1', status: 'discovered' }))
    insertSession(db, makeRow({ id: 'session-2', status: 'closed' }))

    const open = findOpenSessions(db)

    expect(open.map((row) => row.id)).toEqual(['session-1'])
  })

  it('returns an empty array when every session is closed', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow({ id: 'session-1', status: 'closed' }))

    expect(findOpenSessions(db)).toEqual([])
  })
})

describe('markSessionClosed', () => {
  it('updates only the status column for the given sessionId', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow())

    markSessionClosed(db, 'session-1')

    const found = findSessionById(db, 'session-1')
    expect(found).toEqual({ ...makeRow(), status: 'closed' })
  })

  it('does not affect other sessions', () => {
    const db = openRegistryDb(':memory:')
    insertSession(db, makeRow({ id: 'session-1' }))
    insertSession(db, makeRow({ id: 'session-2', threadId: 'thread-2' }))

    markSessionClosed(db, 'session-1')

    expect(findSessionById(db, 'session-1')?.status).toBe('closed')
    expect(findSessionById(db, 'session-2')?.status).toBe('discovered')
  })
})
