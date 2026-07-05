/* eslint-disable unicorn/import-style, unicorn/name-replacements */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { readBootTimeEpochMs, readProcessStartTicks } from './proc.js'

/** Result of resolving a Claude Code sessionId for a detected tmux/claude process (§4). */
export type SessionIdResolution =
  | { kind: 'resolved'; sessionId: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unresolved' }

const CLOCK_TICKS_PER_SECOND = 100 // Linux USER_HZ; 100 on virtually all modern kernels/architectures.

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

function stripJsonlExtension(file: string): string {
  return file.replace(/\.jsonl$/, '')
}

/**
 * Resolves the Claude Code sessionId for `pid` running in `cwd` under
 * `containerConfigDir` (§4 step 4). Tries `sessions/<pid>.json` first
 * (primary source), then falls back to the JSONL-creation-time heuristic
 * (§4 step 4b): if exactly one `.jsonl` candidate exists it is used
 * unconditionally; if several exist, the one whose creation time is
 * closest to the process start time is used, unless the gap to the
 * second-closest candidate is under `ambiguityThresholdMs`, in which case
 * the resolution is reported as ambiguous.
 */
export function resolveSessionId(
  procRoot: string,
  containerConfigDir: string,
  pid: string,
  cwd: string,
  ambiguityThresholdMs: number
): SessionIdResolution {
  const markerPath = join(containerConfigDir, 'sessions', `${pid}.json`)
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      sessionId: string
    }
    return { kind: 'resolved', sessionId: marker.sessionId }
  }

  const projectDir = join(containerConfigDir, 'projects', projectDirName(cwd))
  if (!existsSync(projectDir)) {
    return { kind: 'unresolved' }
  }
  const jsonlFiles = readdirSync(projectDir).filter((file) =>
    file.endsWith('.jsonl')
  )
  if (jsonlFiles.length === 0) {
    return { kind: 'unresolved' }
  }
  if (jsonlFiles.length === 1) {
    return { kind: 'resolved', sessionId: stripJsonlExtension(jsonlFiles[0]) }
  }

  const startTicks = readProcessStartTicks(procRoot, pid)
  const bootEpochMs = readBootTimeEpochMs(procRoot)
  const processStartMs =
    bootEpochMs + (startTicks / CLOCK_TICKS_PER_SECOND) * 1000

  const scored = jsonlFiles
    .map((file) => {
      const createdMs = statSync(join(projectDir, file)).birthtimeMs
      return { file, diff: Math.abs(createdMs - processStartMs) }
    })
    .toSorted((a, b) => a.diff - b.diff)

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
