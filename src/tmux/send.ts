import type { ExecFunction } from './list-sessions'

/**
 * Delivers `text` to the tmux pane identified by `paneTarget` (tmux's own
 * pane id, e.g. `%7`) via paste-buffer, then submits it to the running
 * program (Claude Code) with Enter.
 *
 * Steps:
 * 1. `set-buffer -b <uniqueBufferName> -- <text>` writes `text` into a
 *    uniquely-named buffer. `--` prevents a `text` value starting with `-`
 *    from being misparsed as an option. The buffer name must be unique per
 *    call: tmux buffers are shared across the whole server, so two
 *    concurrent deliveries (different sessions) using the same fixed name
 *    could race and overwrite each other's content before pasting.
 * 2. `paste-buffer -p -d -b <uniqueBufferName> -t <paneTarget>` pastes it.
 *    `-p` enables bracketed paste: if the destination program has
 *    requested bracketed paste mode, embedded newlines are delivered as
 *    literal content instead of being interpreted as Enter keypresses,
 *    which is what makes multi-line text and code blocks safe to send.
 *    `-d` deletes the buffer immediately after pasting.
 * 3. `send-keys -t <paneTarget> Enter` submits the pasted input.
 *
 * Throws if any of the three tmux invocations fails; the caller is
 * responsible for marking the originating `input_queue` row as `failed`.
 */
export async function sendTextToPane(
  exec: ExecFunction,
  socketPath: string,
  paneTarget: string,
  uniqueBufferName: string,
  text: string
): Promise<void> {
  await exec(socketPath, ['set-buffer', '-b', uniqueBufferName, '--', text])
  await exec(socketPath, [
    'paste-buffer',
    '-p',
    '-d',
    '-b',
    uniqueBufferName,
    '-t',
    paneTarget,
  ])
  await exec(socketPath, ['send-keys', '-t', paneTarget, 'Enter'])
}
