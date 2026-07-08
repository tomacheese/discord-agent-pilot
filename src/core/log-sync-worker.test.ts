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

/** Waits until `isConditionMet()` is true or `timeoutMs` elapses, polling every 20ms. */
async function waitFor(
  isConditionMet: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now()
  while (!isConditionMet()) {
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
    threadNameSource: 'fallback',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('runLogSyncCycle', () => {
  let temporaryDirectory: string
  let jsonlPath: string

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), 'log-sync-worker-test-')
    )
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
    const thread: DiscordThread = {
      send,
      sendTyping,
      setName: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
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
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as {
        jsonl_offset: number
      }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    db.close()
  })

  it('advances jsonl_offset past a line whose post fails, instead of retrying forever', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const send = vi.fn().mockRejectedValue(new Error('discord API error'))
    const thread: DiscordThread = {
      send,
      sendTyping: vi.fn(),
      setName: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
      pollIntervalMs: 50,
    }
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'always fails' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()

    // The failure on the earlier line must not have permanently wedged the
    // tailer: a later line is still processed normally.
    send.mockResolvedValue(undefined)
    const nextLine =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'next line' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line + nextLine)
    await waitFor(() =>
      send.mock.calls.some(
        (call) => (call[0] as { content?: string }).content === 'next line'
      )
    )

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
    const thread: DiscordThread = {
      send,
      sendTyping: vi.fn(),
      setName: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
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
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as {
        jsonl_offset: number
      }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(send).not.toHaveBeenCalled()
    db.close()
  })

  it('continues processing subsequent lines in the same batch after an earlier line fails to post', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const send = vi.fn().mockImplementation((input: { content?: string }) => {
      if (input.content === 'first line') {
        return Promise.reject(new Error('discord API error'))
      }
      return Promise.resolve(undefined)
    })
    const thread: DiscordThread = {
      send,
      sendTyping: vi.fn(),
      setName: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
      pollIntervalMs: 50,
    }
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    const line1 =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first line' }] },
      }) + '\n'
    const line2 =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second line' }] },
      }) + '\n'
    const batch = line1 + line2
    writeFileSync(jsonlPath, batch)

    // Both lines are processed in the same batch: the 1st fails and is
    // skipped, the 2nd still succeeds — the failure does not stop the batch.
    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(batch, 'utf8')
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, { content: 'first line' })
    expect(send).toHaveBeenNthCalledWith(2, { content: 'second line' })

    errorSpy.mockRestore()
    db.close()
  })

  it('posts a user text entry when input_queue is empty (transitional behavior)', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const send = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = {
      send,
      sendTyping: vi.fn(),
      setName: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
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

  it('does not consume an input_queue echo entry when the line containing it fails to post', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    db.prepare(
      `INSERT INTO input_queue (session_id, source, body, state, created_at)
       VALUES ('session-1', 'user-1', 'from discord', 'sent', 1)`
    ).run()
    const send = vi.fn().mockRejectedValue(new Error('discord API error'))
    const thread: DiscordThread = {
      send,
      sendTyping: vi.fn(),
      setName: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
      pollIntervalMs: 50,
    }
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'from discord' },
            { type: 'text', text: 'not an echo' },
          ],
        },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    // The echoed block is suppressed at format stage (never sent); only the
    // non-echo block is attempted, and it fails once.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ content: 'not an echo' })
    // The input_queue row must remain unconsumed: the line's post failed and
    // was skipped rather than successfully reflected in Discord.
    const inputQueueRow = db
      .prepare(`SELECT state FROM input_queue WHERE session_id = 'session-1'`)
      .get() as { state: string }
    expect(inputQueueRow.state).toBe('sent')

    errorSpy.mockRestore()
    db.close()
  })

  it('does not lose lines when getThread resolves undefined once, then resolves a thread on retry', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const send = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = {
      send,
      sendTyping: vi.fn(),
      setName: vi.fn().mockResolvedValue(undefined),
    }
    let threadFetchCount = 0
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => {
        threadFetchCount += 1
        if (threadFetchCount === 1) return Promise.resolve(undefined)
        return Promise.resolve(thread)
      },
      pollIntervalMs: 50,
    }
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello again' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    // First attempt: getThread resolves undefined, so onLines must reject
    // (not silently return) and jsonl_offset must not advance.
    await waitFor(() => threadFetchCount >= 1)
    let row = db
      .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
      .get('session-1') as { jsonl_offset: number }
    expect(row.jsonl_offset).toBe(0)

    // A no-op append still triggers a change event on most platforms and
    // forces the tailer to retry the same unconfirmed batch, this time with
    // a thread available.
    writeFileSync(jsonlPath, line)
    await waitFor(() => send.mock.calls.length > 0, 5000)
    expect(send).toHaveBeenCalledWith({ content: 'hello again' })
    await waitFor(() => {
      row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })

    errorSpy.mockRestore()
    db.close()
  })

  it('renames the thread when an ai-title entry appears and records the source', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const setName = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      setName,
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
      pollIntervalMs: 50,
    }

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login bug' }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => setName.mock.calls.length > 0)
    expect(setName).toHaveBeenCalledWith('Fix login bug')
    await waitFor(() => {
      const row = db
        .prepare(
          'SELECT thread_name_source AS threadNameSource FROM sessions WHERE id = ?'
        )
        .get('session-1') as { threadNameSource: string }
      return row.threadNameSource === 'ai-title'
    })
    db.close()
  })

  it('does not downgrade an already-applied agent-name when an ai-title appears', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(
      db,
      makeSession({ jsonlPath, threadNameSource: 'agent-name' })
    )
    const setName = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      setName,
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
      pollIntervalMs: 50,
    }

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({ type: 'ai-title', aiTitle: 'stale summary' }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(setName).not.toHaveBeenCalled()
    db.close()
  })

  it('does not downgrade to ai-title after an agent-name was applied earlier in the same tailer', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const setName = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      setName,
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
      pollIntervalMs: 50,
    }

    // Start a single tailer for this session (one reconcile cycle) so both
    // lines below are processed by the same tailer/closure, exercising the
    // in-memory session object across two onLines batches.
    await runLogSyncCycle(dependencies)

    const agentNameLine =
      JSON.stringify({ type: 'agent-name', agentName: 'auth-refactor' }) + '\n'
    writeFileSync(jsonlPath, agentNameLine)

    await waitFor(() => setName.mock.calls.length > 0)
    expect(setName).toHaveBeenCalledWith('auth-refactor')
    await waitFor(() => {
      const row = db
        .prepare(
          'SELECT thread_name_source AS threadNameSource FROM sessions WHERE id = ?'
        )
        .get('session-1') as { threadNameSource: string }
      return row.threadNameSource === 'agent-name'
    })

    // A later ai-title line arrives through the same tailer. Without the
    // fix, the tailer's stale in-memory session object would still compare
    // against 'fallback' and incorrectly downgrade the name.
    const aiTitleLine =
      JSON.stringify({ type: 'ai-title', aiTitle: 'stale summary' }) + '\n'
    const batch = agentNameLine + aiTitleLine
    writeFileSync(jsonlPath, batch)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(batch, 'utf8')
    })

    expect(setName).toHaveBeenCalledTimes(1)
    expect(setName).toHaveBeenCalledWith('auth-refactor')
    const row = db
      .prepare(
        'SELECT thread_name_source AS threadNameSource FROM sessions WHERE id = ?'
      )
      .get('session-1') as { threadNameSource: string }
    expect(row.threadNameSource).toBe('agent-name')

    db.close()
  })

  it('applies an agent-name over a previously-applied ai-title', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath, threadNameSource: 'ai-title' }))
    const setName = vi.fn().mockResolvedValue(undefined)
    const thread: DiscordThread = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      setName,
    }
    const dependencies: LogSyncDependencies = {
      db,
      getThread: () => Promise.resolve(thread),
      pollIntervalMs: 50,
    }

    await runLogSyncCycle(dependencies)
    const line =
      JSON.stringify({ type: 'agent-name', agentName: 'auth-refactor' }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => setName.mock.calls.length > 0)
    expect(setName).toHaveBeenCalledWith('auth-refactor')
    db.close()
  })
})
