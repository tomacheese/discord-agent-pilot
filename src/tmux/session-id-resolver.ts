import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Config } from '../config/schema'
import { readBootTimeEpochMs, readProcessStartTicks } from './proc'

/** A resolved sessionId paired with the absolute path of its JSONL file. */
export interface SessionIdCandidate {
  sessionId: string
  jsonlPath: string
}

/** Result of resolving a Claude Code sessionId for a detected tmux/claude process. */
export type SessionIdResolution =
  | { kind: 'resolved'; sessionId: string; jsonlPath: string }
  | { kind: 'ambiguous'; candidates: SessionIdCandidate[] }
  | { kind: 'unresolved' }

const CLOCK_TICKS_PER_SECOND = 100 // Linux USER_HZ; 100 on virtually all modern kernels/architectures.

/**
 * Validates the plugin-provided marker file's contents. `sessionId`
 * is restricted to a safe filename-like character set: it is later
 * interpolated into a filesystem path (`jsonlPath`) and used as a Discord
 * thread title, so a value containing `/` or other path-manipulation
 * characters must be rejected rather than trusted verbatim.
 */
const sessionMarkerSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .regex(
      /^[\w.-]+$/,
      'sessionId must contain only alphanumerics, underscore, dot, or hyphen'
    ),
})

/**
 * Maps a host-side CLAUDE_CONFIG_DIR path to its container-side path using
 * `config.configDirs`/`config.claude.defaultConfigDir`. Throws if
 * `hostConfigDirectory` matches neither.
 */
export function resolveContainerConfigDirectory(
  config: Config,
  hostConfigDirectory: string
): string {
  const match = config.configDirs.find(
    (entry) => entry.hostPath === hostConfigDirectory
  )
  if (match) return match.containerPath
  if (config.claude.defaultConfigDir.hostPath === hostConfigDirectory) {
    return config.claude.defaultConfigDir.containerPath
  }
  throw new Error(`No configDirs mapping for host path: ${hostConfigDirectory}`)
}

/**
 * Slugifies `cwd` into the directory name real Claude Code uses under
 * `~/.claude/projects/` for that working directory: both `/` and `.` are
 * replaced with `-` (e.g. `/mnt/ssd/repos/github.com/foo` becomes
 * `-mnt-ssd-repos-github-com-foo`).
 *
 * This is the single source of truth for this conversion. `orchestrator.ts`
 * must import this function rather than reimplementing it — a duplicate
 * definition that only replaced `/` (Issue #16) caused sessionId resolution
 * to always fail for cwds containing a dot, such as this repository's own
 * checkout path.
 */
export function slugifyProjectCwd(cwd: string): string {
  return cwd.replaceAll(/[./]/g, '-')
}

/** Strips the trailing `.jsonl` extension from a Claude Code session log filename. */
function stripJsonlExtension(file: string): string {
  return file.replace(/\.jsonl$/, '')
}

/** Reads `filePath`'s content, or `undefined` if it does not exist. Rethrows any other error. */
async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Lists `directory`'s entries, or an empty array if it does not exist. Rethrows any other error. */
async function readdirIfExists(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** A `.jsonl` file discovered under a `~/.claude/projects/<dir>` directory. */
interface JsonlFileEntry {
  /** Absolute path to the project directory containing this file. */
  directory: string
  /** File name including the `.jsonl` extension. */
  file: string
}

/** Lists every `.jsonl` file across every directory directly under `projectsRoot`. */
async function listAllJsonlFiles(
  projectsRoot: string
): Promise<JsonlFileEntry[]> {
  const projectDirectoryNames = await readdirIfExists(projectsRoot)
  const nested = await Promise.all(
    projectDirectoryNames.map(async (directoryName) => {
      const directory = path.join(projectsRoot, directoryName)
      const files = await readdirIfExists(directory)
      return files
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => ({ directory, file }))
    })
  )
  return nested.flat()
}

/**
 * Searches every directory under `projectsRoot` for a file literally named
 * `<sessionId>.jsonl`, returning its absolute path if found. Used when
 * `sessionId` is already known (from a marker file) but the cwd-derived
 * directory doesn't contain it — an exact filename match needs no
 * birthtime heuristic.
 */
async function findJsonlBySessionId(
  projectsRoot: string,
  sessionId: string
): Promise<string | undefined> {
  const projectDirectoryNames = await readdirIfExists(projectsRoot)
  const targetFile = `${sessionId}.jsonl`
  for (const directoryName of projectDirectoryNames) {
    const directory = path.join(projectsRoot, directoryName)
    const files = await readdirIfExists(directory)
    if (files.includes(targetFile)) {
      return path.join(directory, targetFile)
    }
  }
  return undefined
}

/** Computes the wall-clock time (epoch ms) at which process `pid` started. */
async function computeProcessStartMs(
  procRoot: string,
  pid: string
): Promise<number> {
  const startTicks = await readProcessStartTicks(procRoot, pid)
  const bootEpochMs = await readBootTimeEpochMs(procRoot)
  return bootEpochMs + (startTicks / CLOCK_TICKS_PER_SECOND) * 1000
}

/**
 * Picks the entry whose JSONL birthtime is closest to `processStartMs`
 * among `entries` (which must have at least 2 elements — callers handle
 * the 0/1-length cases themselves), or reports ambiguity if the top two
 * are within `ambiguityThresholdMs` of each other.
 */
async function resolveByBirthtime(
  entries: JsonlFileEntry[],
  processStartMs: number,
  ambiguityThresholdMs: number
): Promise<SessionIdResolution> {
  const unsortedScored = await Promise.all(
    entries.map(async (entry) => {
      const jsonlPath = path.join(entry.directory, entry.file)
      const stats = await stat(jsonlPath)
      return {
        sessionId: stripJsonlExtension(entry.file),
        jsonlPath,
        diff: Math.abs(stats.birthtimeMs - processStartMs),
      }
    })
  )
  const scored = unsortedScored.toSorted((a, b) => a.diff - b.diff)

  // `scored` always has at least 2 entries here per this function's
  // precondition, so `best`/`second` are always defined.
  const [best, second] = scored
  if (second.diff - best.diff < ambiguityThresholdMs) {
    return {
      kind: 'ambiguous',
      candidates: scored.map((entry) => ({
        sessionId: entry.sessionId,
        jsonlPath: entry.jsonlPath,
      })),
    }
  }
  return {
    kind: 'resolved',
    sessionId: best.sessionId,
    jsonlPath: best.jsonlPath,
  }
}

/**
 * Resolves the Claude Code sessionId (and its JSONL file's real path) for
 * `pid` running in `cwd` under `containerConfigDirectory`.
 *
 * Resolution order:
 * 1. If a plugin-provided marker file (`sessions/<pid>.json`) exists, take
 *    its `sessionId` and search every directory under `projects/` for a
 *    `<sessionId>.jsonl` exact filename match. If none is found, return
 *    `unresolved` rather than trusting the marker's `sessionId` without a
 *    verified `jsonlPath`.
 * 2. Otherwise, look in the cwd-derived directory (fast path). If it has
 *    exactly one `.jsonl` file, resolve to it. If it has more than one,
 *    apply the birthtime heuristic within that directory.
 * 3. If the cwd-derived directory has no `.jsonl` files at all (e.g. cwd
 *    drifted from the session's real start-time cwd, such as a worktree
 *    switch), widen the search to every directory under `projects/` and
 *    apply the same birthtime heuristic across all of them combined.
 * 4. If nothing is found anywhere, return `unresolved`.
 */
export async function resolveSessionId(
  procRoot: string,
  containerConfigDirectory: string,
  pid: string,
  cwd: string,
  ambiguityThresholdMs: number
): Promise<SessionIdResolution> {
  const projectsRoot = path.join(containerConfigDirectory, 'projects')

  const markerPath = path.join(
    containerConfigDirectory,
    'sessions',
    `${pid}.json`
  )
  const markerContent = await readFileIfExists(markerPath)
  if (markerContent !== undefined) {
    const marker = sessionMarkerSchema.parse(JSON.parse(markerContent))
    const jsonlPath = await findJsonlBySessionId(projectsRoot, marker.sessionId)
    if (jsonlPath === undefined) return { kind: 'unresolved' }
    return { kind: 'resolved', sessionId: marker.sessionId, jsonlPath }
  }

  const projectDirectory = path.join(projectsRoot, slugifyProjectCwd(cwd))
  const cwdFiles = await readdirIfExists(projectDirectory)
  const cwdEntries: JsonlFileEntry[] = cwdFiles
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => ({ directory: projectDirectory, file }))

  if (cwdEntries.length === 1) {
    const [only] = cwdEntries
    return {
      kind: 'resolved',
      sessionId: stripJsonlExtension(only.file),
      jsonlPath: path.join(only.directory, only.file),
    }
  }
  if (cwdEntries.length > 1) {
    const processStartMs = await computeProcessStartMs(procRoot, pid)
    return resolveByBirthtime(cwdEntries, processStartMs, ambiguityThresholdMs)
  }

  // cwdEntries.length === 0: widen the search to every project directory.
  const allEntries = await listAllJsonlFiles(projectsRoot)
  if (allEntries.length === 0) {
    return { kind: 'unresolved' }
  }
  if (allEntries.length === 1) {
    const [only] = allEntries
    return {
      kind: 'resolved',
      sessionId: stripJsonlExtension(only.file),
      jsonlPath: path.join(only.directory, only.file),
    }
  }
  const processStartMs = await computeProcessStartMs(procRoot, pid)
  return resolveByBirthtime(allEntries, processStartMs, ambiguityThresholdMs)
}
