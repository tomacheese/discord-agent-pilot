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
    expect(version).toBe(6)
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
      expect(version).toBe(6)
      db2.close()
    })
  })
})

describe('input_queue migration', () => {
  it('creates the input_queue table', () => {
    const db = openRegistryDb(':memory:')
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'input_queue'"
      )
      .get()
    expect(row).toBeDefined()
    db.close()
  })

  it('bumps user_version to the latest migration', () => {
    const db = openRegistryDb(':memory:')
    const version = db.pragma('user_version', { simple: true })
    expect(version).toBe(6)
    db.close()
  })

  it('allows inserting and selecting a row referencing an existing session', () => {
    const db = openRegistryDb(':memory:')
    db.prepare(
      `INSERT INTO sessions
         (id, thread_id, parent_channel_id, tmux_session, tmux_pane_pid, cwd,
          config_dir, jsonl_path, jsonl_offset, status, created_at, updated_at)
       VALUES
         ('session-1', 'thread-1', 'channel-1', 'tmux-1', '123', '/cwd',
          '/config', '/cwd/session-1.jsonl', 0, 'active', 1, 1)`
    ).run()
    db.prepare(
      `INSERT INTO input_queue (session_id, source, body, state, created_at)
       VALUES ('session-1', 'user-1', 'hello', 'sent', 1)`
    ).run()
    const row = db
      .prepare('SELECT session_id AS sessionId, body, state FROM input_queue')
      .get()
    expect(row).toEqual({
      sessionId: 'session-1',
      body: 'hello',
      state: 'sent',
    })
    db.close()
  })
})

describe('input_queue index migration', () => {
  it('creates an index on input_queue(session_id, state)', () => {
    const db = openRegistryDb(':memory:')
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'input_queue'"
      )
      .get()
    expect(row).toBeDefined()
    db.close()
  })
})
