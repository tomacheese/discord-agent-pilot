import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import * as fsModule from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJsonlTailer, type TailedLine } from './tail'

/**
 * Mocks the `node:fs` `watch` export so tests can force it to throw
 * synchronously or capture the returned `FSWatcher` to trigger its `'error'`
 * event. `importOriginal` is used so every other `node:fs` export (used by
 * `tail.ts` and this test file's own fixtures) keeps its real behavior.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: vi.fn(actual.watch),
  }
})

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

describe('createJsonlTailer', () => {
  let temporaryDirectory: string
  let filePath: string

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'jsonl-tailer-test-'))
    filePath = path.join(temporaryDirectory, 'session.jsonl')
  })

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('reports complete lines appended after startOffset, with byte offsets', async () => {
    writeFileSync(filePath, '')
    const received: TailedLine[][] = []
    const tailer = createJsonlTailer(filePath, 0, (lines) => {
      received.push(lines)
      return Promise.resolve()
    })
    tailer.start()
    appendFileSync(filePath, '{"a":1}\n{"a":2}\n')
    await waitFor(() => received.length > 0)
    tailer.stop()

    expect(received[0]).toEqual([
      { text: '{"a":1}', offsetAfter: 8 },
      { text: '{"a":2}', offsetAfter: 16 },
    ])
  })

  it('buffers an incomplete trailing line until it is completed', async () => {
    writeFileSync(filePath, '')
    const received: TailedLine[][] = []
    const tailer = createJsonlTailer(filePath, 0, (lines) => {
      received.push(lines)
      return Promise.resolve()
    })
    tailer.start()
    appendFileSync(filePath, '{"a":1}\n{"partial"')
    await waitFor(() => received.length > 0)
    appendFileSync(filePath, ':true}\n')
    await waitFor(() => received.flat().length > 1)
    tailer.stop()

    const allLines = received.flat()
    expect(allLines).toEqual([
      { text: '{"a":1}', offsetAfter: 8 },
      { text: '{"partial":true}', offsetAfter: 25 },
    ])
  })

  it('resumes from startOffset without re-reporting earlier lines', async () => {
    writeFileSync(filePath, '{"a":1}\n{"a":2}\n')
    const received: TailedLine[][] = []
    const tailer = createJsonlTailer(filePath, 8, (lines) => {
      received.push(lines)
      return Promise.resolve()
    })
    tailer.start()
    appendFileSync(filePath, '{"a":3}\n')
    await waitFor(() => received.flat().length > 0)
    tailer.stop()

    expect(received.flat()).toEqual([
      { text: '{"a":2}', offsetAfter: 16 },
      { text: '{"a":3}', offsetAfter: 24 },
    ])
  })

  it('handles multi-byte UTF-8 content with correct byte offsets', async () => {
    writeFileSync(filePath, '')
    const received: TailedLine[][] = []
    const tailer = createJsonlTailer(filePath, 0, (lines) => {
      received.push(lines)
      return Promise.resolve()
    })
    tailer.start()
    const line = '{"text":"こんにちは"}'
    appendFileSync(filePath, `${line}\n`)
    await waitFor(() => received.length > 0)
    tailer.stop()

    expect(received[0]).toEqual([
      { text: line, offsetAfter: Buffer.byteLength(line, 'utf8') + 1 },
    ])
  })

  it('does not advance past a batch whose onLines call rejects, and retries it', async () => {
    writeFileSync(filePath, '')
    let callCount = 0
    const received: TailedLine[][] = []
    const tailer = createJsonlTailer(filePath, 0, (lines) => {
      callCount += 1
      if (callCount === 1) {
        return Promise.reject(new Error('simulated post failure'))
      }
      received.push(lines)
      return Promise.resolve()
    })
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    tailer.start()
    appendFileSync(filePath, '{"a":1}\n')
    await waitFor(() => callCount >= 1)
    // Trigger a retry by appending a byte (an empty-string append performs
    // no write syscall and would not reliably emit an fs.watch event).
    // The tailer re-reads from the still-unconfirmed offset 0, so the
    // pending "{"a":1}\n" line is retried together with this new byte
    // buffered as an incomplete trailing line.
    appendFileSync(filePath, ' ')
    await waitFor(() => received.length > 0, 5000)
    tailer.stop()
    errorSpy.mockRestore()

    expect(received[0]).toEqual([{ text: '{"a":1}', offsetAfter: 8 }])
  })

  it('falls back to polling and still detects new lines when fs.watch throws synchronously', async () => {
    writeFileSync(filePath, '')
    const watchMock = vi.mocked(fsModule.watch)
    watchMock.mockImplementationOnce(() => {
      throw new Error('simulated fs.watch failure')
    })
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)
    const received: TailedLine[][] = []
    const tailer = createJsonlTailer(
      filePath,
      0,
      (lines) => {
        received.push(lines)
        return Promise.resolve()
      },
      50
    )
    tailer.start()
    appendFileSync(filePath, '{"a":1}\n')
    await waitFor(() => received.length > 0, 5000)
    tailer.stop()
    warnSpy.mockRestore()

    expect(received[0]).toEqual([{ text: '{"a":1}', offsetAfter: 8 }])
  })

  it('falls back to polling and still detects new lines after fs.watch emits an error event', async () => {
    writeFileSync(filePath, '')
    const watchMock = vi.mocked(fsModule.watch)
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)
    const received: TailedLine[][] = []
    const tailer = createJsonlTailer(
      filePath,
      0,
      (lines) => {
        received.push(lines)
        return Promise.resolve()
      },
      50
    )
    tailer.start()
    await waitFor(() => watchMock.mock.results.length > 0)
    const watcher = watchMock.mock.results[0].value as FSWatcher
    watcher.emit('error', new Error('simulated watch error'))

    appendFileSync(filePath, '{"a":1}\n')
    await waitFor(() => received.length > 0, 5000)
    tailer.stop()
    warnSpy.mockRestore()

    expect(received[0]).toEqual([{ text: '{"a":1}', offsetAfter: 8 }])
  })
})
