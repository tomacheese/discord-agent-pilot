import path from 'node:path'

/** Discord's hard limit on thread names, in characters. */
const DISCORD_THREAD_NAME_MAX_LENGTH = 100

/** Fixed fallback used when `cwd`'s last path segment would otherwise be empty. */
const UNKNOWN_PROJECT_NAME = 'session'

/**
 * Derives the human-readable project name from `cwd` (its last path
 * segment). Falls back to `'session'` if `cwd` is empty, `/`, or otherwise
 * yields an empty last segment — this function never returns an empty string.
 * Note: a single trailing slash (e.g. `/repos/foo/`) does NOT hit this
 * fallback, since `node:path`'s `basename` already strips trailing separators
 * before computing the last segment.
 */
export function projectNameFromCwd(cwd: string): string {
  const base = path.basename(cwd)
  return base === '' ? UNKNOWN_PROJECT_NAME : base
}

/** Truncates `title` to `maxLength` (Discord thread names cap at 100 chars). */
export function truncateThreadTitle(
  title: string,
  maxLength: number = DISCORD_THREAD_NAME_MAX_LENGTH
): string {
  return title.slice(0, maxLength)
}

/**
 * Builds the fallback thread title used until an `agent-name`/`ai-title`
 * JSONL entry appears: "<project name> (<tmux session name>)". Truncated to
 * Discord's 100-character thread name limit.
 */
export function buildFallbackThreadTitle(
  cwd: string,
  tmuxSession: string
): string {
  const projectName = projectNameFromCwd(cwd)
  return truncateThreadTitle(`${projectName} (${tmuxSession})`)
}
