/* eslint-disable unicorn/import-style, unicorn/name-replacements */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Config } from '../config/schema.js'
import { readBootTimeEpochMs, readProcessStartTicks } from './proc.js'

/** Result of resolving a Claude Code sessionId for a detected tmux/claude process (§4). */
export type SessionIdResolution =
  | { kind: 'resolved'; sessionId: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unresolved' }

const CLOCK_TICKS_PER_SECOND = 100 // Linux USER_HZ; 100 on virtually all modern kernels/architectures.

/**
 * Validates the plugin-provided marker file's contents (§4.1). `sessionId`
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
 * `config.configDirs`/`config.claude.defaultConfigDir` (§6). Throws if
 * `hostConfigDir` matches neither.
 */
export function resolveContainerConfigDir(
  config: Config,
  hostConfigDir: string
): string {
  const match = config.configDirs.find(
    (entry) => entry.hostPath === hostConfigDir
  )
  if (match) return match.containerPath
  if (config.claude.defaultConfigDir.hostPath === hostConfigDir) {
    return config.claude.defaultConfigDir.containerPath
  }
  throw new Error(`No configDirs mapping for host path: ${hostConfigDir}`)
}

/** Converts a cwd into Claude Code's on-disk project directory name (`/` replaced with `-`). */
function projectDirName(cwd: string): string {
  return cwd.replaceAll('/', '-')
}

/** Strips the trailing `.jsonl` extension from a Claude Code session log filename. */
function stripJsonlExtension(file: string): string {
  return file.replace(/\.jsonl$/, '')
}

/** Reads `path`'s content, or `undefined` if it does not exist. Rethrows any other error. */
async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
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

/**
 * Resolves the Claude Code sessionId for `pid` running in `cwd` under
 * `containerConfigDir` (§4 step 4). Prefers the plugin-provided marker file
 * when present, falling back to a JSONL-creation-time heuristic otherwise —
 * see the implementation below for the exact resolution order; this
 * comment intentionally doesn't restate it step-by-step to avoid drifting
 * out of sync with the code.
 */
export async function resolveSessionId(
  procRoot: string,
  containerConfigDir: string,
  pid: string,
  cwd: string,
  ambiguityThresholdMs: number
): Promise<SessionIdResolution> {
  const markerPath = join(containerConfigDir, 'sessions', `${pid}.json`)
  const markerContent = await readFileIfExists(markerPath)
  if (markerContent !== undefined) {
    const marker = sessionMarkerSchema.parse(JSON.parse(markerContent))
    return { kind: 'resolved', sessionId: marker.sessionId }
  }

  const projectDir = join(containerConfigDir, 'projects', projectDirName(cwd))
  const projectDirEntries = await readdirIfExists(projectDir)
  const jsonlFiles = projectDirEntries.filter((file) => file.endsWith('.jsonl'))
  if (jsonlFiles.length === 0) {
    return { kind: 'unresolved' }
  }
  if (jsonlFiles.length === 1) {
    return { kind: 'resolved', sessionId: stripJsonlExtension(jsonlFiles[0]) }
  }

  const startTicks = await readProcessStartTicks(procRoot, pid)
  const bootEpochMs = await readBootTimeEpochMs(procRoot)
  const processStartMs =
    bootEpochMs + (startTicks / CLOCK_TICKS_PER_SECOND) * 1000

  const unsortedScored = await Promise.all(
    jsonlFiles.map(async (file) => {
      const stats = await stat(join(projectDir, file))
      return { file, diff: Math.abs(stats.birthtimeMs - processStartMs) }
    })
  )
  const scored = unsortedScored.toSorted((a, b) => a.diff - b.diff)

  // `scored` always has at least 2 entries here (the 0/1-length cases
  // return earlier above), so `best`/`second` are always defined.
  const [best, second] = scored
  if (second.diff - best.diff < ambiguityThresholdMs) {
    return {
      kind: 'ambiguous',
      candidates: scored.map((entry) => stripJsonlExtension(entry.file)),
    }
  }
  return { kind: 'resolved', sessionId: stripJsonlExtension(best.file) }
}
