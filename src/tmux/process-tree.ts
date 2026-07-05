import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Reads the immediate child pids of `pid` via
 * `${procRoot}/<pid>/task/<pid>/children`. Returns an empty array if the
 * process has exited or has no children.
 */
function readChildPids(procRoot: string, pid: string): string[] {
  try {
    const raw = readFileSync(
      path.join(procRoot, pid, 'task', pid, 'children'),
      'utf8'
    )
    return raw
      .trim()
      .split(/\s+/)
      .filter((p) => p.length > 0)
  } catch {
    return []
  }
}

/** Reads the command name of `pid` via `${procRoot}/<pid>/comm`. */
function readComm(procRoot: string, pid: string): string {
  try {
    return readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Searches `rootPid` and its descendant processes (breadth-first, via
 * `/task/<pid>/children`) for a process named `claude`. Returns that
 * process's pid, or undefined if none is found.
 */
export function findClaudeProcessPid(
  procRoot: string,
  rootPid: string
): string | undefined {
  const queue: string[] = [rootPid]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const pid = queue.shift()
    if (pid === undefined || seen.has(pid)) continue
    seen.add(pid)
    if (readComm(procRoot, pid) === 'claude') {
      return pid
    }
    queue.push(...readChildPids(procRoot, pid))
  }
  return undefined
}
