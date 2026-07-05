import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

/** A tmux session, as listed by `tmux list-sessions`. */
export interface TmuxSession {
  name: string
}

/** A pane belonging to a tmux session, as listed by `tmux list-panes`. */
export interface TmuxPane {
  paneId: string
  pid: string
}

/** Runs a `tmux` subcommand against the server at `socketPath` and returns its stdout. */
export type ExecFunction = (socketPath: string, arguments_: string[]) => string

/** Default exec implementation: invokes the real `tmux` client binary. */
const defaultExec: ExecFunction = (socketPath, arguments_) =>
  execFileSync('tmux', ['-S', socketPath, ...arguments_], { encoding: 'utf8' })

/** Lists every tmux session on the server at `socketPath`. */
export function listTmuxSessions(
  socketPath: string,
  exec: ExecFunction = defaultExec
): TmuxSession[] {
  const out = exec(socketPath, ['list-sessions', '-F', '#{session_name}'])
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((name) => ({ name }))
}

/** Lists every pane of `sessionName`, including each pane's underlying process pid. */
export function listTmuxPanes(
  socketPath: string,
  sessionName: string,
  exec: ExecFunction = defaultExec
): TmuxPane[] {
  const out = exec(socketPath, [
    'list-panes',
    '-t',
    sessionName,
    '-F',
    '#{pane_id} #{pane_pid}',
  ])
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId, pid] = line.split(' ')
      return { paneId, pid }
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
