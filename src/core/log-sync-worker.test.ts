import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm, utimes } from 'node:fs/promises'
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

/** Returns the `EntryBase` fields required by the library's `assistant`/`user` guards, for spreading into test JSONL fixtures. */
function makeEntryBase(sessionId = 'session-1'): Record<string, unknown> {
  return {
    cwd: '/cwd',
    entrypoint: 'cli',
    gitBranch: 'main',
    isSidechain: false,
    parentUuid: null,
    sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    userType: 'external',
    uuid: 'uuid-1',
    version: '1.0.0',
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
        ...makeEntryBase(),
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg-1',
          model: 'claude-1',
          content: [{ type: 'text', text: 'hello world' }],
        },
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
        ...makeEntryBase(),
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg-1',
          model: 'claude-1',
          content: [{ type: 'text', text: 'always fails' }],
        },
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
        ...makeEntryBase(),
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg-1',
          model: 'claude-1',
          content: [{ type: 'text', text: 'next line' }],
        },
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
        ...makeEntryBase(),
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'from discord' }],
        },
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
        ...makeEntryBase(),
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg-1',
          model: 'claude-1',
          content: [{ type: 'text', text: 'first line' }],
        },
      }) + '\n'
    const line2 =
      JSON.stringify({
        ...makeEntryBase(),
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg-1',
          model: 'claude-1',
          content: [{ type: 'text', text: 'second line' }],
        },
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
        ...makeEntryBase(),
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'typed in tmux' }],
        },
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
        ...makeEntryBase(),
        type: 'user',
        message: {
          role: 'user',
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
        ...makeEntryBase(),
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg-1',
          model: 'claude-1',
          content: [{ type: 'text', text: 'hello again' }],
        },
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
      JSON.stringify({
        type: 'ai-title',
        aiTitle: 'Fix login bug',
        sessionId: 'session-1',
      }) + '\n'
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

  it('advances jsonl_offset past a failing thread rename instead of retrying forever', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    const setName = vi.fn().mockRejectedValue(new Error('discord API error'))
    const thread: DiscordThread = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn(),
      setName,
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
        type: 'ai-title',
        aiTitle: 'Fix login bug',
        sessionId: 'session-1',
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(setName).toHaveBeenCalledTimes(1)
    const row = db
      .prepare(
        'SELECT thread_name_source AS threadNameSource FROM sessions WHERE id = ?'
      )
      .get('session-1') as { threadNameSource: string }
    // The failed rename must not be recorded as the applied source.
    expect(row.threadNameSource).toBe('fallback')

    errorSpy.mockRestore()
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
      JSON.stringify({
        type: 'ai-title',
        aiTitle: 'stale summary',
        sessionId: 'session-1',
      }) + '\n'
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
      JSON.stringify({
        type: 'agent-name',
        agentName: 'auth-refactor',
        sessionId: 'session-1',
      }) + '\n'
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
      JSON.stringify({
        type: 'ai-title',
        aiTitle: 'stale summary',
        sessionId: 'session-1',
      }) + '\n'
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
      JSON.stringify({
        type: 'agent-name',
        agentName: 'auth-refactor',
        sessionId: 'session-1',
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => setName.mock.calls.length > 0)
    expect(setName).toHaveBeenCalledWith('auth-refactor')
    db.close()
  })

  it('skips a line with invalid JSON syntax, advances the offset, and warns', async () => {
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
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    const line = '{not valid json\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(send).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
    db.close()
  })

  it('skips a line with an unrecognized type, advances the offset, and does not warn', async () => {
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
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    const line = JSON.stringify({ type: 'totally-unrecognized-type' }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(send).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    db.close()
  })

  it('skips a known-type line with a non-conforming shape, advances the offset, and warns with the typeHint/reason', async () => {
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
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    await runLogSyncCycle(dependencies)
    // `type: 'assistant'` but missing EntryBase's required fields, so it
    // becomes `_kind: 'unknown'` (with a typeHint).
    const line = JSON.stringify({ type: 'assistant' }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return row.jsonl_offset === Buffer.byteLength(line, 'utf8')
    })
    expect(send).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('assistant'),
      expect.any(String)
    )

    warnSpy.mockRestore()
    db.close()
  })

  it('ignores an ai-title entry with an empty aiTitle instead of renaming the thread', async () => {
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
      JSON.stringify({
        type: 'ai-title',
        aiTitle: '',
        sessionId: 'session-1',
      }) + '\n'
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

  it('ignores an agent-name entry with an empty agentName instead of renaming the thread', async () => {
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
      JSON.stringify({
        type: 'agent-name',
        agentName: '',
        sessionId: 'session-1',
      }) + '\n'
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

  describe('jsonlPath reconciliation', () => {
    let configDirectory: string
    let projectsRoot: string

    beforeEach(async () => {
      configDirectory = mkdtempSync(path.join(tmpdir(), 'config-dir-'))
      projectsRoot = path.join(configDirectory, 'projects')
      await mkdir(projectsRoot, { recursive: true })
    })

    afterEach(async () => {
      await rm(configDirectory, { recursive: true, force: true })
    })

    it('switches to the newer jsonl file discovered under a different project directory and resets the offset', async () => {
      const oldDirectory = path.join(projectsRoot, 'old-project')
      const newDirectory = path.join(projectsRoot, 'new-project')
      await mkdir(oldDirectory, { recursive: true })
      await mkdir(newDirectory, { recursive: true })
      const oldFile = path.join(oldDirectory, 'session-1.jsonl')
      const newFile = path.join(newDirectory, 'session-1.jsonl')
      writeFileSync(oldFile, '')
      writeFileSync(newFile, '')
      const older = new Date('2026-01-01T00:00:00Z')
      const newer = new Date('2026-01-02T00:00:00Z')
      await utimes(oldFile, older, older)
      await utimes(newFile, newer, newer)

      const db = openRegistryDb(':memory:')
      insertSession(
        db,
        makeSession({
          jsonlPath: oldFile,
          jsonlOffset: 999,
          configDir: configDirectory,
        })
      )
      const send = vi.fn().mockResolvedValue(undefined)
      const thread: DiscordThread = {
        send,
        sendTyping: vi.fn().mockResolvedValue(undefined),
        setName: vi.fn().mockResolvedValue(undefined),
      }
      const dependencies: LogSyncDependencies = {
        db,
        getThread: () => Promise.resolve(thread),
        pollIntervalMs: 50,
      }

      await runLogSyncCycle(dependencies)

      const row = db
        .prepare(
          'SELECT jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset FROM sessions WHERE id = ?'
        )
        .get('session-1') as { jsonlPath: string; jsonlOffset: number }
      expect(row.jsonlPath).toBe(newFile)
      expect(row.jsonlOffset).toBe(0)

      const line =
        JSON.stringify({
          ...makeEntryBase(),
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-1',
            model: 'claude-1',
            content: [{ type: 'text', text: 'from new file' }],
          },
        }) + '\n'
      writeFileSync(newFile, line)

      await waitFor(() => send.mock.calls.length > 0)
      expect(send).toHaveBeenCalledWith({ content: 'from new file' })
      db.close()
    })

    it('seeds the offset from the target file size when switching back to a pre-existing, non-empty file, and only posts newly appended content', async () => {
      const worktreeDirectory = path.join(projectsRoot, 'worktree-project')
      const originalDirectory = path.join(projectsRoot, 'original-project')
      await mkdir(worktreeDirectory, { recursive: true })
      await mkdir(originalDirectory, { recursive: true })
      const worktreeFile = path.join(worktreeDirectory, 'session-1.jsonl')
      const originalFile = path.join(originalDirectory, 'session-1.jsonl')

      // originalFile already has historical content that was presumably
      // synced to Discord in an earlier stretch of the same session, before
      // the process entered the worktree.
      const historicalLine =
        JSON.stringify({
          ...makeEntryBase(),
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-1',
            model: 'claude-1',
            content: [{ type: 'text', text: 'historical content' }],
          },
        }) + '\n'
      writeFileSync(originalFile, historicalLine)
      writeFileSync(worktreeFile, '')

      const older = new Date('2026-01-01T00:00:00Z')
      const newer = new Date('2026-01-02T00:00:00Z')
      // worktreeFile is currently the session's active jsonlPath (newer mtime
      // than originalFile), simulating that the process is inside the
      // worktree right now.
      await utimes(originalFile, older, older)
      await utimes(worktreeFile, newer, newer)

      const db = openRegistryDb(':memory:')
      insertSession(
        db,
        makeSession({
          jsonlPath: worktreeFile,
          jsonlOffset: 0,
          configDir: configDirectory,
        })
      )
      const send = vi.fn().mockResolvedValue(undefined)
      const thread: DiscordThread = {
        send,
        sendTyping: vi.fn().mockResolvedValue(undefined),
        setName: vi.fn().mockResolvedValue(undefined),
      }
      const dependencies: LogSyncDependencies = {
        db,
        getThread: () => Promise.resolve(thread),
        pollIntervalMs: 50,
      }

      // Process exits the worktree: originalFile now becomes the newest
      // (mtime-wise) again, so the next cycle switches back to it.
      const newest = new Date('2026-01-03T00:00:00Z')
      await utimes(originalFile, newest, newest)

      await runLogSyncCycle(dependencies)

      const expectedOffset = Buffer.byteLength(historicalLine, 'utf8')
      const row = db
        .prepare(
          'SELECT jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset FROM sessions WHERE id = ?'
        )
        .get('session-1') as { jsonlPath: string; jsonlOffset: number }
      expect(row.jsonlPath).toBe(originalFile)
      expect(row.jsonlOffset).toBe(expectedOffset)

      // No new content has been appended yet: the historical line must NOT
      // be re-posted.
      expect(send).not.toHaveBeenCalled()

      const newLine =
        JSON.stringify({
          ...makeEntryBase(),
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-1',
            model: 'claude-1',
            content: [{ type: 'text', text: 'new content after switch back' }],
          },
        }) + '\n'
      writeFileSync(originalFile, historicalLine + newLine)

      await waitFor(() => send.mock.calls.length > 0)
      expect(send).toHaveBeenCalledWith({
        content: 'new content after switch back',
      })
      expect(send).not.toHaveBeenCalledWith({ content: 'historical content' })
      db.close()
    })

    it('skips jsonlPath re-resolution within the hysteresis window after a switch, then re-checks once it elapses', async () => {
      vi.useFakeTimers()
      try {
        const oldDirectory = path.join(projectsRoot, 'old-project')
        const newDirectory = path.join(projectsRoot, 'new-project')
        await mkdir(oldDirectory, { recursive: true })
        await mkdir(newDirectory, { recursive: true })
        const oldFile = path.join(oldDirectory, 'session-1.jsonl')
        const newFile = path.join(newDirectory, 'session-1.jsonl')
        writeFileSync(oldFile, '')
        writeFileSync(newFile, '')
        const older = new Date('2026-01-01T00:00:00Z')
        const newer = new Date('2026-01-02T00:00:00Z')
        await utimes(oldFile, older, older)
        await utimes(newFile, newer, newer)

        const db = openRegistryDb(':memory:')
        insertSession(
          db,
          makeSession({ jsonlPath: oldFile, configDir: configDirectory })
        )
        const thread: DiscordThread = {
          send: vi.fn().mockResolvedValue(undefined),
          sendTyping: vi.fn().mockResolvedValue(undefined),
          setName: vi.fn().mockResolvedValue(undefined),
        }
        const dependencies: LogSyncDependencies = {
          db,
          getThread: () => Promise.resolve(thread),
          pollIntervalMs: 50,
        }

        await runLogSyncCycle(dependencies)
        let row = db
          .prepare('SELECT jsonl_path AS jsonlPath FROM sessions WHERE id = ?')
          .get('session-1') as { jsonlPath: string }
        expect(row.jsonlPath).toBe(newFile)

        // A third location appears right after the switch, within the
        // hysteresis window: reconciliation must NOT jump to it yet.
        const thirdDirectory = path.join(projectsRoot, 'third-project')
        await mkdir(thirdDirectory, { recursive: true })
        const thirdFile = path.join(thirdDirectory, 'session-1.jsonl')
        writeFileSync(thirdFile, '')
        const newest = new Date('2026-01-03T00:00:00Z')
        await utimes(thirdFile, newest, newest)

        vi.advanceTimersByTime(5000) // still within HYSTERESIS_MS (10s)
        await runLogSyncCycle(dependencies)
        row = db
          .prepare('SELECT jsonl_path AS jsonlPath FROM sessions WHERE id = ?')
          .get('session-1') as { jsonlPath: string }
        expect(row.jsonlPath).toBe(newFile) // unchanged: still within hysteresis

        vi.advanceTimersByTime(6000) // now past HYSTERESIS_MS since the first switch
        await runLogSyncCycle(dependencies)
        row = db
          .prepare('SELECT jsonl_path AS jsonlPath FROM sessions WHERE id = ?')
          .get('session-1') as { jsonlPath: string }
        expect(row.jsonlPath).toBe(thirdFile) // now switches

        db.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('continues reconciling other sessions when one session fails to resolve its jsonlPath', async () => {
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)

      // "session-bad": configDirectory points at a plain file, not a directory,
      // so readdir(path.join(configDirectory, 'projects')) throws ENOTDIR rather
      // than the ENOENT that readdirIfExists tolerates.
      const badConfigDirectory = path.join(
        projectsRoot,
        '..',
        'not-a-directory'
      )
      writeFileSync(badConfigDirectory, '')

      const oldDirectory = path.join(projectsRoot, 'old-project')
      const newDirectory = path.join(projectsRoot, 'new-project')
      await mkdir(oldDirectory, { recursive: true })
      await mkdir(newDirectory, { recursive: true })
      const oldFile = path.join(oldDirectory, 'session-good.jsonl')
      const newFile = path.join(newDirectory, 'session-good.jsonl')
      writeFileSync(oldFile, '')
      writeFileSync(newFile, '')
      const older = new Date('2026-01-01T00:00:00Z')
      const newer = new Date('2026-01-02T00:00:00Z')
      await utimes(oldFile, older, older)
      await utimes(newFile, newer, newer)

      const db = openRegistryDb(':memory:')
      insertSession(
        db,
        makeSession({
          id: 'session-bad',
          jsonlPath: path.join(configDirectory, 'irrelevant.jsonl'),
          configDir: badConfigDirectory,
        })
      )
      insertSession(
        db,
        makeSession({
          id: 'session-good',
          jsonlPath: oldFile,
          configDir: configDirectory,
        })
      )
      const thread: DiscordThread = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
        setName: vi.fn().mockResolvedValue(undefined),
      }
      const dependencies: LogSyncDependencies = {
        db,
        getThread: () => Promise.resolve(thread),
        pollIntervalMs: 50,
      }

      await runLogSyncCycle(dependencies)

      expect(errorSpy).toHaveBeenCalled()
      const row = db
        .prepare('SELECT jsonl_path AS jsonlPath FROM sessions WHERE id = ?')
        .get('session-good') as { jsonlPath: string }
      expect(row.jsonlPath).toBe(newFile)

      db.close()
      errorSpy.mockRestore()
    })

    it('waits for a stale in-flight write from a superseded tailer to drain (via flush()) before completing the jsonlPath switch', async () => {
      const oldDirectory = path.join(projectsRoot, 'old-project')
      const newDirectory = path.join(projectsRoot, 'new-project')
      await mkdir(oldDirectory, { recursive: true })
      await mkdir(newDirectory, { recursive: true })
      const oldFile = path.join(oldDirectory, 'session-1.jsonl')
      const newFile = path.join(newDirectory, 'session-1.jsonl')

      const oldLine =
        JSON.stringify({
          ...makeEntryBase(),
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-1',
            model: 'claude-1',
            content: [{ type: 'text', text: 'from old file' }],
          },
        }) + '\n'
      writeFileSync(oldFile, oldLine)
      const older = new Date('2026-01-01T00:00:00Z')
      await utimes(oldFile, older, older)
      // newFile does not exist yet: on the first cycle it must not be a
      // reconciliation candidate at all, so the old tailer actually starts
      // and reads the pre-existing line. It is created only after the first
      // cycle, right before the switch-detecting second cycle.

      const db = openRegistryDb(':memory:')
      insertSession(
        db,
        makeSession({ jsonlPath: oldFile, configDir: configDirectory })
      )

      // Controls when the old tailer's in-flight `thread.send()` resolves,
      // so the test can force the jsonlPath switch to happen while that
      // call is still pending (simulating a slow Discord API call racing
      // against the switch detection).
      const { promise: oldSendGate, resolve: releaseOldSend } =
        Promise.withResolvers<undefined>()
      let hasSendCompleted = false
      const send = vi.fn().mockImplementation(async () => {
        await oldSendGate
        hasSendCompleted = true
      })
      const thread: DiscordThread = {
        send,
        sendTyping: vi.fn().mockResolvedValue(undefined),
        setName: vi.fn().mockResolvedValue(undefined),
      }
      const dependencies: LogSyncDependencies = {
        db,
        getThread: () => Promise.resolve(thread),
        pollIntervalMs: 50,
      }

      // First cycle: starts the old tailer. Its fs.watch-triggered internal
      // check() reads the pre-existing line and calls onLines -> processLine
      // -> thread.send(), which hangs on oldSendGate. runLogSyncCycle itself
      // does not wait for this (tail.ts's check() is fire-and-forget), so
      // this call returns immediately.
      await runLogSyncCycle(dependencies)
      await waitFor(() => send.mock.calls.length > 0)

      // newFile appears only now, with a newer mtime than oldFile, so the
      // next cycle's reconciliation detects it as the switch target.
      writeFileSync(newFile, '')
      const newer = new Date('2026-01-02T00:00:00Z')
      await utimes(newFile, newer, newer)

      // Second cycle detects the switch to newFile, but `reconcileJsonlPaths`
      // now awaits `tailer.flush()` on the old tailer before stopping it and
      // completing the switch — so this call blocks until the old tailer's
      // pending send resolves. Start it without awaiting immediately so the
      // test can release the gate afterwards.
      const secondCyclePromise = runLogSyncCycle(dependencies)

      // Give the switch-detecting cycle a moment to actually start awaiting
      // `flush()`, confirming it really does block on the pending send
      // rather than completing immediately.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(hasSendCompleted).toBe(false)

      // Release the old tailer's stale in-flight write. `flush()` drains it
      // (advancing the old tailer's internal offset past it and persisting
      // it via the normal `updateJsonlOffset` write, guarded to the OLD
      // jsonlPath), after which the switch to newFile completes.
      releaseOldSend(undefined)
      await waitFor(() => hasSendCompleted)
      await secondCyclePromise

      const row = db
        .prepare(
          'SELECT jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset FROM sessions WHERE id = ?'
        )
        .get('session-1') as { jsonlPath: string; jsonlOffset: number }
      // The switch only completes after the old write drained, so the final
      // state cleanly reflects the new file with a freshly-seeded offset —
      // no stale write can land after the switch and clobber it.
      expect(row.jsonlPath).toBe(newFile)
      expect(row.jsonlOffset).toBe(0)

      db.close()
    })

    it('does not drop trailing unread bytes across a worktree round-trip: content on A written but unread before switching to B is posted, and not duplicated once switched back to A', async () => {
      const directoryA = path.join(projectsRoot, 'project-a')
      const directoryB = path.join(projectsRoot, 'project-b')
      await mkdir(directoryA, { recursive: true })
      await mkdir(directoryB, { recursive: true })
      const fileA = path.join(directoryA, 'session-1.jsonl')
      const fileB = path.join(directoryB, 'session-1.jsonl')

      const line1 =
        JSON.stringify({
          ...makeEntryBase(),
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-1',
            model: 'claude-1',
            content: [{ type: 'text', text: 'a-line-1' }],
          },
        }) + '\n'
      const line2 =
        JSON.stringify({
          ...makeEntryBase(),
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-1',
            model: 'claude-1',
            content: [{ type: 'text', text: 'a-line-2-trailing' }],
          },
        }) + '\n'
      const line3 =
        JSON.stringify({
          ...makeEntryBase(),
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-1',
            model: 'claude-1',
            content: [{ type: 'text', text: 'a-line-3-after-return' }],
          },
        }) + '\n'

      writeFileSync(fileA, line1)
      const t1 = new Date('2026-01-01T00:00:00Z')
      await utimes(fileA, t1, t1)

      const db = openRegistryDb(':memory:')
      insertSession(
        db,
        makeSession({ jsonlPath: fileA, configDir: configDirectory })
      )
      const send = vi.fn().mockResolvedValue(undefined)
      const thread: DiscordThread = {
        send,
        sendTyping: vi.fn().mockResolvedValue(undefined),
        setName: vi.fn().mockResolvedValue(undefined),
      }
      const dependencies: LogSyncDependencies = {
        db,
        getThread: () => Promise.resolve(thread),
        pollIntervalMs: 50,
      }

      // First cycle: no fileB yet, so fileA is the only candidate and no
      // switch happens; the tailer for fileA starts and (via real fs.watch)
      // reads and posts line1.
      await runLogSyncCycle(dependencies)
      await waitFor(() => send.mock.calls.length > 0)
      expect(send).toHaveBeenCalledWith({ content: 'a-line-1' })

      // Append line2 to fileA but do NOT wait for fs.watch to pick it up:
      // it must remain unread by fileA's running tailer at the moment the
      // switch to fileB is triggered below, reproducing "trailing unread
      // bytes at switch-away time".
      writeFileSync(fileA, line1 + line2)
      // Re-apply fileA's older mtime: the write above bumped it to "now",
      // which would otherwise make it look newer than fileB below.
      await utimes(fileA, t1, t1)
      writeFileSync(fileB, '')
      const t2 = new Date('2026-01-02T00:00:00Z')
      await utimes(fileB, t2, t2)

      // Skip past HYSTERESIS_MS between the two switches below without a
      // real 10s wait.
      vi.useFakeTimers()
      try {
        // Second cycle detects the switch to fileB. `reconcileJsonlPaths`
        // flushes fileA's tailer first, which drains line2 (regardless of
        // whether fs.watch had already picked it up) and posts it — this is
        // the fix for Finding 5/7: without it, line2 could be silently
        // skipped forever once fileA's raw byte size already includes it.
        await runLogSyncCycle(dependencies)

        let row = db
          .prepare(
            'SELECT jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset FROM sessions WHERE id = ?'
          )
          .get('session-1') as { jsonlPath: string; jsonlOffset: number }
        expect(row.jsonlPath).toBe(fileB)
        expect(row.jsonlOffset).toBe(0)
        expect(send).toHaveBeenCalledWith({ content: 'a-line-2-trailing' })

        vi.advanceTimersByTime(11_000) // past HYSTERESIS_MS (10s)

        // Switch back: fileA becomes the newest again.
        const t3 = new Date('2026-01-03T00:00:00Z')
        await utimes(fileA, t3, t3)

        await runLogSyncCycle(dependencies)

        row = db
          .prepare(
            'SELECT jsonl_path AS jsonlPath, jsonl_offset AS jsonlOffset FROM sessions WHERE id = ?'
          )
          .get('session-1') as { jsonlPath: string; jsonlOffset: number }
        expect(row.jsonlPath).toBe(fileA)
        // The round-trip must resume from the offset this session already
        // finished reading up to on fileA (line1 + line2), not re-derive it
        // from fileA's current byte size (which happens to be the same
        // value here, but for the wrong reason — see the assertion below
        // that neither line is reposted once tailing resumes).
        expect(row.jsonlOffset).toBe(Buffer.byteLength(line1 + line2, 'utf8'))
      } finally {
        vi.useRealTimers()
      }

      // Append line3 after switching back to fileA; the newly (re)started
      // tailer must pick it up via real fs.watch/polling.
      writeFileSync(fileA, line1 + line2 + line3)
      await waitFor(() => send.mock.calls.length >= 3)
      expect(send).toHaveBeenCalledWith({ content: 'a-line-3-after-return' })

      const line1Calls = send.mock.calls.filter(
        (call) => (call[0] as { content?: string }).content === 'a-line-1'
      )
      const line2Calls = send.mock.calls.filter(
        (call) =>
          (call[0] as { content?: string }).content === 'a-line-2-trailing'
      )
      expect(line1Calls).toHaveLength(1)
      expect(line2Calls).toHaveLength(1)

      db.close()
    })
  })
})
