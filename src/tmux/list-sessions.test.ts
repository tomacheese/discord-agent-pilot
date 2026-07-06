import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  listAllTmuxPanes,
  resolveTmuxSocketPath,
  type ExecFunction,
} from './list-sessions'

describe('listAllTmuxPanes', () => {
  it('parses session name, pane id, and pid per line', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue('session-a:%0:1111\nsession-b:%1:2222\n')

    const panes = await listAllTmuxPanes('/tmp/tmux-host/default', exec)

    expect(panes).toEqual([
      { sessionName: 'session-a', paneId: '%0', pid: '1111' },
      { sessionName: 'session-b', paneId: '%1', pid: '2222' },
    ])
    expect(exec).toHaveBeenCalledWith('/tmp/tmux-host/default', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}:#{pane_id}:#{pane_pid}',
    ])
  })

  it('parses a session name containing a space without misaligning fields', async () => {
    const exec = vi.fn().mockResolvedValue('my project:%0:1111\n')

    const panes = await listAllTmuxPanes('/tmp/tmux-host/default', exec)

    expect(panes).toEqual([
      { sessionName: 'my project', paneId: '%0', pid: '1111' },
    ])
  })

  it('returns an empty array when tmux exits non-zero (no server/no sessions)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('no server running'))

    expect(await listAllTmuxPanes('/tmp/tmux-host/default', exec)).toEqual([])
  })

  it('throws on an unexpected output line missing a field', async () => {
    const exec = vi.fn().mockResolvedValue('session-a:%0\n')

    await expect(
      listAllTmuxPanes('/tmp/tmux-host/default', exec)
    ).rejects.toThrow('Unexpected tmux list-panes -a output line')
  })

  // Regression test for a bug found during real-environment integration
  // testing (Issue #13): some tmux client builds (observed with Alpine's
  // tmux 3.6b talking to a tmux 3.6 server) replace literal control
  // characters embedded in a `-F` format string (e.g. a tab) with `_` in
  // their output. Using a tab as FIELD_DELIMITER therefore corrupted every
  // line and made `listAllTmuxPanes` throw on every detection cycle. The
  // delimiter must be a printable, non-control character that tmux also
  // guarantees can never appear inside a session name (tmux itself rewrites
  // literal colons in session names to underscores at creation time).
  it('does not use a tab or other control character as the field delimiter', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('session-a:%0:1111\n')

    await listAllTmuxPanes('/tmp/tmux-host/default', exec)

    expect(exec).toHaveBeenCalledTimes(1)
    const formatArgument = exec.mock.calls[0][1][3]
    // eslint-disable-next-line no-control-regex
    expect(formatArgument).not.toMatch(/[\u{0}-\u{1F}\u{7F}]/u)
  })
})

describe('resolveTmuxSocketPath', () => {
  it('returns the path to the socket file found inside socketDir', () => {
    const socketDirectory = mkdtempSync(path.join(tmpdir(), 'dap-tmux-socket-'))
    writeFileSync(path.join(socketDirectory, 'default'), '')

    expect(resolveTmuxSocketPath(socketDirectory)).toBe(
      path.join(socketDirectory, 'default')
    )
  })

  it('throws when socketDir is empty', () => {
    const socketDirectory = mkdtempSync(
      path.join(tmpdir(), 'dap-tmux-socket-empty-')
    )
    expect(() => resolveTmuxSocketPath(socketDirectory)).toThrow()
  })

  it('prefers the socket named "default" when multiple sockets exist', () => {
    const socketDirectory = mkdtempSync(
      path.join(tmpdir(), 'dap-tmux-socket-multi-')
    )
    writeFileSync(path.join(socketDirectory, 'other-user'), '')
    writeFileSync(path.join(socketDirectory, 'default'), '')

    expect(resolveTmuxSocketPath(socketDirectory)).toBe(
      path.join(socketDirectory, 'default')
    )
  })

  it('throws when multiple sockets exist and none is named "default"', () => {
    const socketDirectory = mkdtempSync(
      path.join(tmpdir(), 'dap-tmux-socket-ambiguous-')
    )
    writeFileSync(path.join(socketDirectory, 'user-a'), '')
    writeFileSync(path.join(socketDirectory, 'user-b'), '')

    expect(() => resolveTmuxSocketPath(socketDirectory)).toThrow()
  })
})
