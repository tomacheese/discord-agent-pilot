import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openRegistryDb } from './db'

describe('openRegistryDb', () => {
  it('creates the sessions table', () => {
    const db = openRegistryDb(':memory:')
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
      )
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

  describe('against a real file', () => {
    let temporaryDirectory: string
    let dbPath: string

    beforeEach(() => {
      temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'registry-db-test-'))
      dbPath = path.join(temporaryDirectory, 'registry.db')
    })

    afterEach(() => {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    })

    it('is idempotent when opened twice against the same file', () => {
      const db1 = openRegistryDb(dbPath)
      db1.close()
      const db2 = openRegistryDb(dbPath)
      const version = db2.pragma('user_version', { simple: true })
      expect(version).toBe(1)
      db2.close()
    })
  })
})
