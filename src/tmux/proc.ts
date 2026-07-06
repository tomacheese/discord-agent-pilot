import { readFile, readlink } from 'node:fs/promises'
import path from 'node:path'

/** Resolves the working directory of `pid` via `${procRoot}/<pid>/cwd`. */
export async function readProcessCwd(
  procRoot: string,
  pid: string
): Promise<string> {
  return readlink(path.join(procRoot, pid, 'cwd'))
}

/**
 * Parses `${procRoot}/<pid>/environ` (NUL-separated `KEY=VALUE` entries)
 * into a plain object. The return type reflects that an arbitrary key may
 * legitimately be absent at runtime (there is no guarantee any particular
 * environment variable was set for the process).
 */
export async function readProcessEnviron(
  procRoot: string,
  pid: string
): Promise<Record<string, string | undefined>> {
  const raw = await readFile(path.join(procRoot, pid, 'environ'), 'utf8')
  const environment: Record<string, string | undefined> = {}
  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq === -1) continue
    environment[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return environment
}

/**
 * Reads the process start time (field 22 of `${procRoot}/<pid>/stat`, in
 * clock ticks since boot). The `comm` field may itself contain spaces or
 * parentheses, so fields are parsed relative to the last `)` rather than
 * naive whitespace splitting on the whole line.
 */
export async function readProcessStartTicks(
  procRoot: string,
  pid: string
): Promise<number> {
  const raw = await readFile(path.join(procRoot, pid, 'stat'), 'utf8')
  const afterComm = raw.slice(raw.lastIndexOf(')') + 1).trim()
  const fields = afterComm.split(/\s+/)
  // fields[0] is "state" (field 3 overall); starttime is field 22 overall,
  // i.e. index 19 in this array (0-based, starting from state).
  return Number(fields[19])
}

/**
 * Reads the system boot time (in epoch milliseconds) via `${procRoot}/stat`'s
 * `btime` line. Combined with `readProcessStartTicks`, this converts a
 * process's start time (clock ticks since boot) into an absolute time
 * comparable to file mtimes.
 */
export async function readBootTimeEpochMs(procRoot: string): Promise<number> {
  const raw = await readFile(path.join(procRoot, 'stat'), 'utf8')
  const line = raw.split('\n').find((l) => l.startsWith('btime '))
  if (!line) {
    throw new Error(`btime not found in ${procRoot}/stat`)
  }
  return Number(line.split(/\s+/, 2)[1]) * 1000
}
