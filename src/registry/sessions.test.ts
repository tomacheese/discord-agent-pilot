/* eslint-disable unicorn/name-replacements,@typescript-eslint/no-confusing-void-expression */
import { describe, expect, it } from 'vitest'
import { openRegistryDb } from './db.js'
import { findSessionById, insertSession, type SessionRow } from './sessions.js'

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    threadId: 'thread-1',
    parentChannelId: 'channel-1',
    tmuxSession: 'tmux-1',
    tmuxPanePid: '1234',
    cwd: '/mnt/ssd/repos/example',
    configDir: '/host/claude-config',
    jsonlPath: '/host/claude-config/projects/-mnt-ssd-repos-example/session-1.jsonl',
    jsonlOffset: 0,
    status: 'discovered',
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
    expect(() => insertSession(db, makeRow())).toThrow()
  })
})
/* eslint-enable unicorn/name-replacements,@typescript-eslint/no-confusing-void-expression */
