import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openRegistryDb } from '../registry/db'
import { insertSession, type SessionRow } from '../registry/sessions'
import {
  runLogSyncCycle,
  type DiscordThread,
  type LogSyncDependencies,
} from './log-sync-worker'

/** Waits until `predicate()` is true or `timeoutMs` elapses, polling every 20ms. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    threadId: 'thread-1',
    parentChannelId: 'channel-1',
    tmuxSession: 'tmux-1',
    tmuxPanePid: '123',
    cwd: '/cwd',
    configDir: '/config',
    jsonlPath: '/tmp/should-be-overridden.jsonl',
    jsonlOffset: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('runLogSyncCycle', () => {
  let temporaryDirectory: string
  let jsonlPath: string

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'log-sync-worker-test-'))
    jsonlPath = path.join(temporaryDirectory, 'session.jsonl')
  })

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('posts an assistant text entry and advances jsonl_offset', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const send = vi.fn().mockResolvedValue(undefined)
    const sendTyping = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = { send, sendTyping }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: async () => thread,
      pollIntervalMs: 50,
    }

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello world' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => send.mock.calls.length > 0)
    expect(send).toHaveBeenCalledWith({ content: 'hello world' })
    await waitFor(() => {
      const row = db.prepare('SELECT jsonl_offset FROM sessions WHERE id = ?').get('session-1') as {
        jsonl_offset: number
      }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    db.close()
  })

  it('does not advance jsonl_offset when posting fails, and does not lose the line', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    let callCount = 0
    const send = vi.fn().mockImplementation(() => {
      callCount += 1
      if (callCount === 1) return Promise.reject(new Error('discord API error'))
      return Promise.resolve(undefined)
    })
    const thread: DiscordThread = { send, sendTyping: vi.fn() }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: async () => thread,
      pollIntervalMs: 50,
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'retry me' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => callCount >= 1)
    let row = db.prepare('SELECT jsonl_offset FROM sessions WHERE id = ?').get('session-1') as {
      jsonl_offset: number
    }
    expect(row.jsonl_offset).toBe(0)

    // A no-op append still triggers a change event on most platforms and
    // forces the tailer to retry the same unconfirmed batch.
    writeFileSync(jsonlPath, line)
    await waitFor(() => callCount >= 2, 5000)
    await waitFor(() => {
      row = db.prepare('SELECT jsonl_offset FROM sessions WHERE id = ?').get('session-1') as {
        jsonl_offset: number
      }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    errorSpy.mockRestore()
    db.close()
  })

  it('skips a user text entry matching an unconsumed input_queue record and marks it consumed', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    db.prepare(
      `INSERT INTO input_queue (session_id, source, body, state, created_at)
       VALUES ('session-1', 'user-1', 'from discord', 'sent', 1)`
    ).run()
    const send = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = { send, sendTyping: vi.fn() }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: async () => thread,
      pollIntervalMs: 50,
    }

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'from discord' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db.prepare('SELECT jsonl_offset FROM sessions WHERE id = ?').get('session-1') as {
        jsonl_offset: number
      }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(send).not.toHaveBeenCalled()
    db.close()
  })

  it('posts a user text entry when input_queue is empty (transitional behavior)', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const send = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = { send, sendTyping: vi.fn() }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: async () => thread,
      pollIntervalMs: 50,
    }

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'typed in tmux' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => send.mock.calls.length > 0)
    expect(send).toHaveBeenCalledWith({ content: 'typed in tmux' })
    db.close()
  })
})
