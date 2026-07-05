import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Reads the immediate child pids of `pid` via
 * `${procRoot}/<pid>/task/<pid>/children`. Returns an empty array if the
 * process has exited (`ENOENT`, the expected/common case during a process
 * tree walk). Any other error (e.g. a permission or I/O error) is logged
 * via `console.warn` before also returning an empty array, so a systemic
 * `/proc` read failure leaves a diagnostic trail instead of silently
 * truncating the walk.
 */
async function readChildPids(procRoot: string, pid: string): Promise<string[]> {
  try {
    const raw = await readFile(
      path.join(procRoot, pid, 'task', pid, 'children'),
      'utf8'
    )
    return raw
      .trim()
      .split(/\s+/)
      .filter((p) => p.length > 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Failed to read child pids for pid ${pid}:`, error)
    }
    return []
  }
}

/**
 * Reads the command name of `pid` via `${procRoot}/<pid>/comm`. Returns an
 * empty string if the process has exited (`ENOENT`). Any other error is
 * logged via `console.warn` before also returning an empty string, for the
 * same reason as `readChildPids`.
 */
async function readComm(procRoot: string, pid: string): Promise<string> {
  try {
    const raw = await readFile(path.join(procRoot, pid, 'comm'), 'utf8')
    return raw.trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Failed to read comm for pid ${pid}:`, error)
    }
    return ''
  }
}

/**
 * Searches `rootPid` and its descendant processes (breadth-first, via
 * `/task/<pid>/children`) for a process named `claude`. Returns that
 * process's pid, or undefined if none is found.
 */
export async function findClaudeProcessPid(
  procRoot: string,
  rootPid: string
): Promise<string | undefined> {
  const queue: string[] = [rootPid]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const pid = queue.shift()
    if (pid === undefined || seen.has(pid)) continue
    seen.add(pid)
    if ((await readComm(procRoot, pid)) === 'claude') {
      return pid
    }
    queue.push(...(await readChildPids(procRoot, pid)))
  }
  return undefined
}
