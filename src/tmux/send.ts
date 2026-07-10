import type { ExecFunction } from './list-sessions'

/**
 * Delivers `text` to the tmux pane identified by `paneTarget` (tmux's own
 * pane id, e.g. `%7`), then submits it to the running program (Claude Code)
 * with Enter.
 *
 * Text is written into a uniquely-named tmux buffer and then pasted into
 * the pane, rather than typed via `send-keys` directly: `send-keys` treats
 * embedded newlines as literal Enter keypresses, which would fragment or
 * prematurely submit multi-line text and code blocks. Pasting via a buffer
 * (with bracketed paste enabled) delivers such content as-is, and the
 * buffer is discarded right after the paste so it doesn't linger. The
 * buffer name must be unique per call: tmux buffers are shared across the
 * whole server, so two concurrent deliveries (different sessions) using
 * the same fixed name could race and overwrite each other's content before
 * pasting. See the arguments below for the exact tmux invocations.
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
