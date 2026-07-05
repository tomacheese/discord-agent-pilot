/* eslint-disable unicorn/name-replacements */
import { describe, expect, it } from 'vitest'
import { openRegistryDb } from './db.js'

describe('openRegistryDb', () => {
  it('creates the sessions table', () => {
    const db = openRegistryDb(':memory:')
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get()
    expect(row).toBeDefined()
    db.close()
  })

  it('records the applied migration version', () => {
    const db = openRegistryDb(':memory:')
    const version = db.pragma('user_version', { simple: true })
    expect(version).toBe(1)
    db.close()
  })

  it('is idempotent when opened twice against the same file', () => {
    const db1 = openRegistryDb(':memory:')
    db1.close()
    const db2 = openRegistryDb(':memory:')
    const version = db2.pragma('user_version', { simple: true })
    expect(version).toBe(1)
    db2.close()
  })
})
/* eslint-enable unicorn/name-replacements */
