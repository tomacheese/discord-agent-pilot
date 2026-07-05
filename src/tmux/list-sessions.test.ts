import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  listTmuxPanes,
  listTmuxSessions,
  resolveTmuxSocketPath,
} from './list-sessions.js'

describe('listTmuxSessions', () => {
  it('parses one session per line', () => {
    const exec = vi.fn().mockReturnValue('session-a\nsession-b\n')

    const sessions = listTmuxSessions('/tmp/tmux-host/default', exec)

    expect(sessions).toEqual([{ name: 'session-a' }, { name: 'session-b' }])
    expect(exec).toHaveBeenCalledWith('/tmp/tmux-host/default', [
      'list-sessions',
      '-F',
      '#{session_name}',
    ])
  })

  it('returns an empty array when there are no sessions', () => {
    const exec = vi.fn().mockReturnValue('')
    expect(listTmuxSessions('/tmp/tmux-host/default', exec)).toEqual([])
  })
})

describe('listTmuxPanes', () => {
  it('parses pane id and pid per line', () => {
    const exec = vi.fn().mockReturnValue('%0 1111\n%1 2222\n')

    const panes = listTmuxPanes('/tmp/tmux-host/default', 'session-a', exec)

    expect(panes).toEqual([
      { paneId: '%0', pid: '1111' },
      { paneId: '%1', pid: '2222' },
    ])
    expect(exec).toHaveBeenCalledWith('/tmp/tmux-host/default', [
      'list-panes',
      '-t',
      'session-a',
      '-F',
      '#{pane_id} #{pane_pid}',
    ])
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
})
