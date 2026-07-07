import { describe, expect, it } from 'vitest'
import {
  buildFallbackThreadTitle,
  projectNameFromCwd,
  truncateThreadTitle,
} from './thread-title'

describe('projectNameFromCwd', () => {
  it('returns the last path segment', () => {
    expect(projectNameFromCwd('/mnt/ssd/repos/discord-agent-pilot')).toBe(
      'discord-agent-pilot'
    )
  })

  it('falls back to "session" for an empty cwd', () => {
    expect(projectNameFromCwd('')).toBe('session')
  })

  it('falls back to "session" for a root-only cwd', () => {
    expect(projectNameFromCwd('/')).toBe('session')
  })

  it('ignores a trailing slash rather than treating it as an empty segment', () => {
    // node:path's `basename` already strips trailing separators, so a single
    // trailing slash never actually reaches the "empty last segment"
    // fallback branch.
    expect(projectNameFromCwd('/mnt/ssd/repos/')).toBe('repos')
  })
})

describe('buildFallbackThreadTitle', () => {
  it('combines the project name and tmux session name', () => {
    expect(
      buildFallbackThreadTitle('/mnt/ssd/repos/discord-agent-pilot', 'main')
    ).toBe('discord-agent-pilot (main)')
  })

  it('truncates the combined title to 100 characters', () => {
    // 107 chars total, over the 100-char limit — needed to exercise truncation.
    const longProject = 'p'.repeat(100)
    const title = buildFallbackThreadTitle(`/repos/${longProject}`, 'main')
    expect(title.length).toBe(100)
  })
})

describe('truncateThreadTitle', () => {
  it('returns the title unchanged when within the limit', () => {
    expect(truncateThreadTitle('short title')).toBe('short title')
  })

  it('truncates to the default 100-character limit', () => {
    const long = 'a'.repeat(150)
    expect(truncateThreadTitle(long)).toBe('a'.repeat(100))
  })

  it('truncates to a custom limit', () => {
    expect(truncateThreadTitle('abcdefghij', 5)).toBe('abcde')
  })
})
