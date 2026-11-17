import type { SessionRow } from '../registry/sessions'
import {
  findClaudeProcessPid,
  isClaudeProcessIdentityAlive,
} from '../tmux/process-tree'

/**
 * Returns whether the Claude Code process `session` is bound to is still
 * running. A row with a recorded identity (`claudePid`) is alive only if
 * that exact process instance is; another `claude` started later in the
 * same pane does not keep it alive. A legacy row without an identity falls
 * back to looking for any `claude` process under its pane's shell.
 */
export async function isSessionProcessAlive(
  procRoot: string,
  session: SessionRow
): Promise<boolean> {
  if (session.claudePid !== '') {
    return isClaudeProcessIdentityAlive(
      procRoot,
      session.claudePid,
      session.claudeStartTicks
    )
  }
  return Boolean(await findClaudeProcessPid(procRoot, session.tmuxPanePid))
}
