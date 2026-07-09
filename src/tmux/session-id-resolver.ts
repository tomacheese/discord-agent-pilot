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

// Discord's select-menu component rejects more than 25 options, and
// `promptSessionIdSelection` (src/core/ambiguity.ts) renders one option per
// candidate — so an "ambiguous" result must never carry more than this many.
const MAX_AMBIGUOUS_CANDIDATES = 25

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
 * This is the single source of truth for this conversion, replacing a
 * duplicate definition formerly in `orchestrator.ts` that only replaced `/`
 * (Issue #16) and caused sessionId resolution to always fail for cwds
 * containing a dot, such as this repository's own checkout path.
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
 * Finds a file literally named `<sessionId>.jsonl`, returning its absolute
 * path if found. Used when `sessionId` is already known (from a marker
 * file) — an exact filename match needs no birthtime heuristic.
 *
 * Checks `cwdDirectory` first as a cheap fast path (the marker's session
 * usually still lives in the process's current project directory), then
 * falls back to scanning every directory under `projectsRoot` in parallel.
 */
async function findJsonlBySessionId(
  projectsRoot: string,
  sessionId: string,
  cwdDirectory: string
): Promise<string | undefined> {
  const targetFile = `${sessionId}.jsonl`

  const cwdFiles = await readdirIfExists(cwdDirectory)
  if (cwdFiles.includes(targetFile)) {
    return path.join(cwdDirectory, targetFile)
  }

  const projectDirectoryNames = await readdirIfExists(projectsRoot)
  const matches = await Promise.all(
    projectDirectoryNames.map(async (directoryName) => {
      const directory = path.join(projectsRoot, directoryName)
      const files = await readdirIfExists(directory)
      return files.includes(targetFile)
        ? path.join(directory, targetFile)
        : undefined
    })
  )
  return matches.find((match) => match !== undefined)
}

/**
 * Finds every file literally named `<sessionId>.jsonl` across every
 * directory directly under `projectsRoot`, and returns the path of the one
 * with the most recent `mtime` — the file the Claude Code process is
 * currently writing to. Returns the single match directly without a `stat`
 * call when only one candidate exists. Returns `undefined` if no candidate
 * exists anywhere.
 *
 * Unlike `findJsonlBySessionId`, this does NOT check a cwd-derived
 * directory as a fast path first: right after a cwd switch (e.g. into a
 * git worktree), the old directory still has a stale `<sessionId>.jsonl`
 * left over, and checking it first would always "find" the stale file and
 * never discover that the process moved to a new one (see Issue #25).
 *
 * A candidate whose `stat()` fails (e.g. a broken symlink, or the file
 * disappearing between the directory listing and the stat call) is
 * excluded rather than failing the whole lookup.
 */
export async function findLatestJsonlForSessionId(
  projectsRoot: string,
  sessionId: string
): Promise<string | undefined> {
  const targetFile = `${sessionId}.jsonl`
  const projectDirectoryNames = await readdirIfExists(projectsRoot)
  const matches = await Promise.all(
    projectDirectoryNames.map(async (directoryName) => {
      const directory = path.join(projectsRoot, directoryName)
      const files = await readdirIfExists(directory)
      return files.includes(targetFile)
        ? path.join(directory, targetFile)
        : undefined
    })
  )
  const candidates = matches.filter(
    (match): match is string => match !== undefined
  )
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  const statResults = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stats = await stat(candidate)
        return { candidate, mtimeMs: stats.mtimeMs }
      } catch {
        return undefined
      }
    })
  )
  const scored = statResults.filter(
    (entry): entry is { candidate: string; mtimeMs: number } =>
      entry !== undefined
  )
  if (scored.length === 0) return undefined
  const [latest] = scored.toSorted((a, b) => b.mtimeMs - a.mtimeMs)
  return latest.candidate
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
 *
 * The ambiguous set only includes entries within the threshold of the best
 * match (not every entry in `entries`), and is capped at
 * `MAX_AMBIGUOUS_CANDIDATES`: a global search can turn up far more than 25
 * `.jsonl` files, and `promptSessionIdSelection` renders one Discord
 * select-menu option per candidate.
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
      candidates: scored
        .filter((entry) => entry.diff - best.diff < ambiguityThresholdMs)
        .slice(0, MAX_AMBIGUOUS_CANDIDATES)
        .map((entry) => ({
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
 *    switch), widen the search to every directory under `projects/`. If
 *    exactly one match is found, resolve to it directly; if more than one,
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
  const projectDirectory = path.join(projectsRoot, slugifyProjectCwd(cwd))

  const markerPath = path.join(
    containerConfigDirectory,
    'sessions',
    `${pid}.json`
  )
  const markerContent = await readFileIfExists(markerPath)
  if (markerContent !== undefined) {
    const marker = sessionMarkerSchema.parse(JSON.parse(markerContent))
    const jsonlPath = await findJsonlBySessionId(
      projectsRoot,
      marker.sessionId,
      projectDirectory
    )
    if (jsonlPath === undefined) return { kind: 'unresolved' }
    return { kind: 'resolved', sessionId: marker.sessionId, jsonlPath }
  }

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
