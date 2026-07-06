import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs'

/** A single complete line together with the byte offset immediately after it. */
export interface TailedLine {
  text: string
  offsetAfter: number
}

/** Watches a JSONL file for newly appended complete lines from a given starting byte offset. */
export interface JsonlTailer {
  start(): void
  stop(): void
}

const DEFAULT_POLL_INTERVAL_MS = 1000
const NEWLINE_BYTE = 0x0a

/**
 * Creates a tailer for `filePath` that reports newly appended complete
 * lines (lines ending in `\n`) starting at the byte offset `startOffset`,
 * passing each batch to `onLines`.
 *
 * Uses `fs.watch` as the primary change-detection mechanism. If `fs.watch`
 * fails to start or errors afterward (e.g. `ENOSYS` on platforms/mounts
 * that don't support it, such as some Docker bind mounts), this tailer
 * falls back permanently to polling every `pollIntervalMs`.
 *
 * The internal read offset only advances past a batch once `onLines`
 * resolves successfully; if it rejects, the same batch (plus anything
 * appended meanwhile) is retried on the next detected change.
 */
export function createJsonlTailer(
  filePath: string,
  startOffset: number,
  onLines: (lines: TailedLine[]) => Promise<void>,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
): JsonlTailer {
  let offset = startOffset
  let watcher: FSWatcher | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let processingChain = Promise.resolve()
  let isStopped = false

  /** Reads all newly appended complete lines since `offset`, without advancing `offset`. */
  function readNewLines(): TailedLine[] {
    if (!existsSync(filePath)) return []
    const size = statSync(filePath).size
    if (size <= offset) return []
    const fd = openSync(filePath, 'r')
    try {
      const chunk = Buffer.alloc(size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      const lines: TailedLine[] = []
      let lineStart = 0
      let newlineIndex = chunk.indexOf(NEWLINE_BYTE, lineStart)
      while (newlineIndex !== -1) {
        lines.push({
          text: chunk.subarray(lineStart, newlineIndex).toString('utf8'),
          offsetAfter: offset + newlineIndex + 1,
        })
        lineStart = newlineIndex + 1
        newlineIndex = chunk.indexOf(NEWLINE_BYTE, lineStart)
      }
      return lines
    } finally {
      closeSync(fd)
    }
  }

  /** Queues a single read-and-report cycle, serialized after any in-flight cycle. */
  function check(): void {
    // `.then()/.catch()` is used deliberately instead of `await` here: this
    // function appends to the shared `processingChain` so that each cycle is
    // serialized strictly after the previous one, regardless of how many
    // times `check()` is called (e.g. rapid `fs.watch` events). Awaiting
    // would make `check()` itself async and return a promise per call,
    // losing that single shared serialization point.
    processingChain = processingChain
      // eslint-disable-next-line unicorn/prefer-await
      .then(async () => {
        if (isStopped) return
        const lines = readNewLines()
        if (lines.length === 0) return
        await onLines(lines)
        const lastLine = lines.at(-1)
        if (!lastLine) return
        offset = lastLine.offsetAfter
      })
      // eslint-disable-next-line unicorn/prefer-await
      .catch((error: unknown) => {
        console.error(`Failed to process tailed lines from ${filePath}:`, error)
      })
  }

  function startPolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(check, pollIntervalMs)
  }

  return {
    start(): void {
      isStopped = false
      try {
        watcher = watch(filePath, () => {
          check()
        })
        watcher.on('error', () => {
          watcher?.close()
          watcher = undefined
          startPolling()
        })
      } catch {
        startPolling()
      }
      check()
    },
    stop(): void {
      isStopped = true
      watcher?.close()
      watcher = undefined
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
    },
  }
}
