import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * A pane belonging to a tmux session, as listed by `tmux list-panes -a`,
 * tagged with the name of the session it belongs to.
 */
export interface TmuxPane {
  sessionName: string
  paneId: string
  pid: string
}

/** Runs a `tmux` subcommand against the server at `socketPath` and returns its stdout. */
export type ExecFunction = (
  socketPath: string,
  arguments_: string[]
) => Promise<string>

/** Default exec implementation: invokes the real `tmux` client binary. */
const defaultExec: ExecFunction = async (socketPath, arguments_) => {
  const { stdout } = await execFileAsync('tmux', [
    '-S',
    socketPath,
    ...arguments_,
  ])
  return stdout
}

/**
 * Field delimiter for the `tmux list-panes -F` format string below. A plain
 * space is unsafe — `tmux rename-session "my project"` is valid and would
 * silently misalign the 3-way destructure in `listAllTmuxPanes`. A tab was
 * used originally on the same reasoning (tmux rejects tabs in session
 * names), but real-environment testing (Issue #13) found that some tmux
 * client builds (observed with Alpine's tmux 3.6b talking to a tmux 3.6
 * server) replace literal control characters embedded in a `-F` format
 * string — including tab — with `_` in their output, corrupting every line.
 * Colon keeps the same "can never appear in a session name" guarantee
 * without being a control character: tmux itself rewrites literal colons in
 * session names to underscores at creation time.
 */
const FIELD_DELIMITER = ':'

/**
 * Lists every pane across every tmux session on the server at `socketPath`
 * in a single `tmux list-panes -a` call (avoiding one `list-sessions` plus
 * one `list-panes` call per session). `tmux` exits non-zero both when the
 * server has zero sessions and when no server is running at all on this
 * socket — both are the bot's normal idle state (no panes to detect), not
 * an error, so both are treated as an empty result rather than propagating
 * the exec failure.
 */
export async function listAllTmuxPanes(
  socketPath: string,
  exec: ExecFunction = defaultExec
): Promise<TmuxPane[]> {
  let out: string
  try {
    out = await exec(socketPath, [
      'list-panes',
      '-a',
      '-F',
      // `#{...}` is tmux's own format-string syntax, not a JS template
      // literal typo.
      // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation
      `#{session_name}${FIELD_DELIMITER}#{pane_id}${FIELD_DELIMITER}#{pane_pid}`,
    ])
  } catch {
    return []
  }
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sessionName, paneId, pid] = line.split(FIELD_DELIMITER)
      if (!sessionName || !paneId || !pid) {
        throw new Error(`Unexpected tmux list-panes -a output line: ${line}`)
      }
      return { sessionName, paneId, pid }
    })
}

/**
 * Resolves the tmux server socket file inside `socketDirectory` (bind-mounted
 * from the host's tmux socket directory). Prefers a socket named
 * `default` (tmux's own default socket name) when present; otherwise
 * requires exactly one candidate, since picking an arbitrary entry from a
 * directory with multiple sockets (e.g. multiple tmux servers/users) would
 * be nondeterministic and could silently attach to the wrong server. Throws
 * if no socket file is found, or if multiple non-`default` candidates exist.
 */
export function resolveTmuxSocketPath(socketDirectory: string): string {
  const socketFiles = readdirSync(socketDirectory)
  if (socketFiles.length === 0) {
    throw new Error(`No tmux socket found in ${socketDirectory}`)
  }
  if (socketFiles.includes('default')) {
    return path.join(socketDirectory, 'default')
  }
  if (socketFiles.length > 1) {
    throw new Error(
      `Multiple tmux sockets found in ${socketDirectory} and none is named ` +
        `"default": ${socketFiles.join(', ')}`
    )
  }
  return path.join(socketDirectory, socketFiles[0])
}
