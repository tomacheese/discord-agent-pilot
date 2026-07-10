import { describe, expect, it, vi } from 'vitest'
import type { ExecFunction } from './list-sessions'
import { sendTextToPane } from './send'

describe('sendTextToPane', () => {
  it('sets the buffer, pastes with bracketed paste, and submits with Enter, in order', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue('')

    await sendTextToPane(
      exec,
      '/tmp/tmux-host/default',
      '%7',
      'dap-session-1-42',
      'hello\nworld'
    )

    expect(exec).toHaveBeenNthCalledWith(1, '/tmp/tmux-host/default', [
      'set-buffer',
      '-b',
      'dap-session-1-42',
      '--',
      'hello\nworld',
    ])
    expect(exec).toHaveBeenNthCalledWith(2, '/tmp/tmux-host/default', [
      'paste-buffer',
      '-p',
      '-d',
      '-b',
      'dap-session-1-42',
      '-t',
      '%7',
    ])
    expect(exec).toHaveBeenNthCalledWith(3, '/tmp/tmux-host/default', [
      'send-keys',
      '-t',
      '%7',
      'Enter',
    ])
  })

  it('propagates the error and stops when set-buffer fails', async () => {
    const exec = vi.fn<ExecFunction>().mockRejectedValue(new Error('boom'))

    await expect(
      sendTextToPane(exec, '/tmp/tmux-host/default', '%7', 'buf', 'hi')
    ).rejects.toThrow('boom')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('propagates the error and stops when paste-buffer fails', async () => {
    const exec = vi
      .fn<ExecFunction>()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('paste failed'))

    await expect(
      sendTextToPane(exec, '/tmp/tmux-host/default', '%7', 'buf', 'hi')
    ).rejects.toThrow('paste failed')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('propagates the error when send-keys (Enter) fails', async () => {
    const exec = vi
      .fn<ExecFunction>()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('send-keys failed'))

    await expect(
      sendTextToPane(exec, '/tmp/tmux-host/default', '%7', 'buf', 'hi')
    ).rejects.toThrow('send-keys failed')
    expect(exec).toHaveBeenCalledTimes(3)
  })
})
