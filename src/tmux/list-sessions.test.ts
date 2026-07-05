import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listAllTmuxPanes, resolveTmuxSocketPath } from './list-sessions.js'

describe('listAllTmuxPanes', () => {
  it('parses session name, pane id, and pid per line', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue('session-a\t%0\t1111\nsession-b\t%1\t2222\n')

    const panes = await listAllTmuxPanes('/tmp/tmux-host/default', exec)

    expect(panes).toEqual([
      { sessionName: 'session-a', paneId: '%0', pid: '1111' },
      { sessionName: 'session-b', paneId: '%1', pid: '2222' },
    ])
    expect(exec).toHaveBeenCalledWith('/tmp/tmux-host/default', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{pane_id}\t#{pane_pid}',
    ])
  })

  it('parses a session name containing a space without misaligning fields', async () => {
    const exec = vi.fn().mockResolvedValue('my project\t%0\t1111\n')

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
    const exec = vi.fn().mockResolvedValue('session-a\t%0\n')

    await expect(
      listAllTmuxPanes('/tmp/tmux-host/default', exec)
    ).rejects.toThrow('Unexpected tmux list-panes -a output line')
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
