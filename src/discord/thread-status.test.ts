import { describe, expect, it } from 'vitest'
import { formatThreadStatus, summarizePostItems } from './thread-status'

describe('summarizePostItems', () => {
  it('returns the last text of the last messages item', () => {
    expect(
      summarizePostItems([
        { kind: 'messages', texts: ['first'] },
        { kind: 'messages', texts: ['second', 'third'] },
      ])
    ).toBe('third')
  })

  it('returns undefined for an empty items array', () => {
    expect(summarizePostItems([])).toBeUndefined()
  })

  it('returns undefined for typing-only items', () => {
    expect(summarizePostItems([{ kind: 'typing' }])).toBeUndefined()
  })

  it('truncates a long text to 100 characters', () => {
    const long = 'a'.repeat(150)
    const summary = summarizePostItems([{ kind: 'messages', texts: [long] }])
    expect(summary).toBe('a'.repeat(100) + '…')
  })
})

describe('formatThreadStatus', () => {
  it('shows "実行中" and the elapsed minutes for a running session', () => {
    const content = formatThreadStatus({
      title: 'discord-agent-pilot (main)',
      isRunning: true,
      lastActionSummary: '⏺ Bash(ls -la)',
      elapsedMinutes: 12,
    })
    expect(content).toBe(
      'Session thread: discord-agent-pilot (main)\n状態: 実行中 (経過 12分)\n直近: ⏺ Bash(ls -la)'
    )
  })

  it('shows "停止中" for a stopped session', () => {
    const content = formatThreadStatus({
      title: 'discord-agent-pilot (main)',
      isRunning: false,
      lastActionSummary: '⏺ Bash(ls -la)',
      elapsedMinutes: 5,
    })
    expect(content).toContain('状態: 停止中 (経過 5分)')
  })

  it('shows the no-action placeholder when lastActionSummary is empty', () => {
    const content = formatThreadStatus({
      title: 'discord-agent-pilot (main)',
      isRunning: true,
      lastActionSummary: '',
      elapsedMinutes: 0,
    })
    expect(content).toContain('直近: (まだアクションなし)')
  })

  it('truncates the overall content to 300 characters', () => {
    const content = formatThreadStatus({
      title: 'discord-agent-pilot (main)',
      isRunning: true,
      lastActionSummary: 'x'.repeat(400),
      elapsedMinutes: 1,
    })
    expect(content.length).toBe(301) // 300 chars + the truncation ellipsis
  })
})
