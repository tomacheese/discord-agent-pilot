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
 * Field delimiter for the `tmux list-panes -F` format string below. A tab
 * cannot appear in a tmux session name (tmux itself rejects it), unlike a
 * plain space — `tmux rename-session "my project"` is valid and would
 * otherwise silently misalign the 3-way destructure in `listAllTmuxPanes`.
 */
const FIELD_DELIMITER = '\t'

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
 * from the host's tmux socket directory, §6/§13.1). Throws if no socket
 * file is found.
 */
export function resolveTmuxSocketPath(socketDirectory: string): string {
  const [socketFile] = readdirSync(socketDirectory)
  if (!socketFile) {
    throw new Error(`No tmux socket found in ${socketDirectory}`)
  }
  return path.join(socketDirectory, socketFile)
}
