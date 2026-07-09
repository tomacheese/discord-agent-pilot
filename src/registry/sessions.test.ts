import { describe, expect, it } from 'vitest'
import { openRegistryDb } from './db'
import {
  findSessionById,
  getThreadNameSource,
  insertSession,
  updateJsonlPath,
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
    cwd: '/mnt/ssd/repos/example',
    configDir: '/host/claude-config',
    jsonlPath:
      '/host/claude-config/projects/-mnt-ssd-repos-example/session-1.jsonl',
    jsonlOffset: 0,
    status: 'discovered',
    threadNameSource: 'fallback',
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
