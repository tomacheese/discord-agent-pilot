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
        message: { content: [{ type: 'text', text: 'retry me' }] },
      }) + '\n'
    writeFileSync(jsonlPath, line)

    await waitFor(() => callCount >= 1)
    let row = db
      .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
      .get('session-1') as {
      jsonl_offset: number
    }
    expect(row.jsonl_offset).toBe(0)

    // A no-op append still triggers a change event on most platforms and
    // forces the tailer to retry the same unconfirmed batch.
    writeFileSync(jsonlPath, line)
    await waitFor(() => callCount >= 2, 5000)
    await waitFor(() => {
      row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as {
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

  it('does not repost an earlier line in a retried multi-line batch after a later line fails', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    let callCount = 0
    const send = vi.fn().mockImplementation(() => {
      callCount += 1
      // The 2nd call (posting the 2nd line's content) fails on the first
      // attempt, but succeeds afterwards. The 1st call (1st line) always
      // succeeds.
      if (callCount === 2) return Promise.reject(new Error('discord API error'))
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

    // Wait for both lines to have been attempted once (1st succeeds, 2nd
    // rejects), which fails the whole onLines batch and leaves jsonl_offset
    // stuck at the offset after line1 (since that UPDATE already committed
    // before line2 threw).
    await waitFor(() => callCount >= 2)
    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as {
        jsonl_offset: number
      }
      return row.jsonl_offset === Buffer.byteLength(line1, 'utf8')
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, { content: 'first line' })

    // A no-op append still triggers a change event on most platforms and
    // forces the tailer to retry the same unconfirmed batch (both lines,
    // since the tailer's in-memory offset never advanced past the batch
    // start).
    writeFileSync(jsonlPath, batch)
    await waitFor(() => {
      const row = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as {
        jsonl_offset: number
      }
      return row.jsonl_offset === Buffer.byteLength(batch, 'utf8')
    }, 5000)

    // The 1st line must not have been reposted: only the original call to
    // send its content, plus exactly one more call (the retried 2nd line).
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenNthCalledWith(3, { content: 'second line' })
    const firstLineCalls = send.mock.calls.filter(
      (call) => (call[0] as { content?: string }).content === 'first line'
    )
    expect(firstLineCalls).toHaveLength(1)

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

  it('does not lose or duplicate an echo when a later block in the same line fails and retries', async () => {
    const db = openRegistryDb(':memory:')
    writeFileSync(jsonlPath, '')
    insertSession(db, makeSession({ jsonlPath }))
    db.prepare(
      `INSERT INTO input_queue (session_id, source, body, state, created_at)
       VALUES ('session-1', 'user-1', 'from discord', 'sent', 1)`
    ).run()
    let callCount = 0
    const send = vi.fn().mockImplementation(() => {
      callCount += 1
      // The 2nd content block's post (the non-echo text) fails on the first
      // attempt, but succeeds afterwards.
      if (callCount === 1) return Promise.reject(new Error('discord API error'))
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

    // First attempt: the echo block is suppressed (not sent), so the only
    // `send` call is for the non-echo block, which fails. jsonl_offset must
    // not advance.
    await waitFor(() => callCount >= 1)
    const row = db
      .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
      .get('session-1') as {
      jsonl_offset: number
    }
    expect(row.jsonl_offset).toBe(0)

    // A no-op append still triggers a change event on most platforms and
    // forces the tailer to retry the same unconfirmed line.
    writeFileSync(jsonlPath, line)
    await waitFor(() => {
      const retriedRow = db
        .prepare('SELECT jsonl_offset FROM sessions WHERE id = ?')
        .get('session-1') as { jsonl_offset: number }
      return retriedRow.jsonl_offset === Buffer.byteLength(line, 'utf8')
    }, 5000)

    // The echoed block must never have been sent, on either the failed
    // first attempt or the successful retry: if the echo-consumed marker
    // were (incorrectly) recorded before the line's post fully succeeded,
    // the retry would re-evaluate `isEcho('from discord')` as `false` and
    // post it as a duplicate.
    const echoCalls = send.mock.calls.filter(
      (call) => (call[0] as { content?: string }).content === 'from discord'
    )
    expect(echoCalls).toHaveLength(0)
    // The non-echo block is attempted on both the failed first try and the
    // successful retry (2 `send` calls total: 1 rejection + 1 success) —
    // this is a single logical post that failed once and succeeded once,
    // not a duplicate post to Discord.
    expect(callCount).toBe(2)
    expect(send).toHaveBeenCalledWith({ content: 'not an echo' })

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
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'from new file' }] },
        }) + '\n'
      writeFileSync(newFile, line)

      await waitFor(() => send.mock.calls.length > 0)
      expect(send).toHaveBeenCalledWith({ content: 'from new file' })
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
  })
})
