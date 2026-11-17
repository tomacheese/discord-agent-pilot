import { describe, expect, it } from 'vitest'
import type { SessionRow } from '../registry/sessions'
import { makeFakeProcRoot, writeFakeProcess } from '../test-utils/fake-proc'
import { isSessionProcessAlive } from './session-liveness'

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    threadId: 'thread-1',
    parentChannelId: 'channel-1',
    tmuxSession: 'tmux-1',
    tmuxPanePid: '100',
    tmuxPaneId: '%0',
    claudePid: '300',
    claudeStartTicks: 5000,
    cwd: '/mnt/ssd/repos/example',
    configDir: '/host/claude-config',
    jsonlPath: '/host/claude-config/projects/x/session-1.jsonl',
    jsonlOffset: 0,
    status: 'discovered',
    threadNameSource: 'fallback',
    lastActionSummary: '',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('isSessionProcessAlive', () => {
  it('is true when the bound process identity matches', async () => {
    const procRoot = makeFakeProcRoot()
    writeFakeProcess(procRoot, '300', { comm: 'claude', startTicks: 5000 })

    await expect(
      isSessionProcessAlive(procRoot, makeSessionRow())
    ).resolves.toBe(true)
  })

  it('is false for a stale row even when another claude runs in the same pane', async () => {
    const procRoot = makeFakeProcRoot()
    writeFakeProcess(procRoot, '100', {
      comm: 'bash',
      startTicks: 1,
      children: ['400'],
    })
    writeFakeProcess(procRoot, '400', { comm: 'claude', startTicks: 8000 })

    await expect(
      isSessionProcessAlive(procRoot, makeSessionRow())
    ).resolves.toBe(false)
  })

  it('uses the pane-level process lookup for a legacy row without an identity', async () => {
    const procRoot = makeFakeProcRoot()
    writeFakeProcess(procRoot, '100', {
      comm: 'bash',
      startTicks: 1,
      children: ['400'],
    })
    writeFakeProcess(procRoot, '400', { comm: 'claude', startTicks: 8000 })
    const legacy = makeSessionRow({ claudePid: '', claudeStartTicks: 0 })

    await expect(isSessionProcessAlive(procRoot, legacy)).resolves.toBe(true)
  })

  it('is false for a legacy row whose pane no longer hosts claude', async () => {
    const procRoot = makeFakeProcRoot()
    writeFakeProcess(procRoot, '100', { comm: 'bash', startTicks: 1 })
    const legacy = makeSessionRow({ claudePid: '', claudeStartTicks: 0 })

    await expect(isSessionProcessAlive(procRoot, legacy)).resolves.toBe(false)
  })
})
