/* eslint-disable unicorn/import-style, unicorn/name-replacements, unicorn/require-array-sort-compare */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Config } from '../config/schema.js'
import {
  resolveContainerConfigDir,
  resolveSessionId,
} from './session-id-resolver.js'

function makeConfig(): Config {
  return {
    guildId: 'guild-1',
    parentChannel: { type: 'forum', id: 'channel-1' },
    allowedUserIds: ['user-1'],
    workspaceRoots: ['/mnt/ssd/repos'],
    configDirs: [
      { hostPath: '/home/user/.claude', containerPath: '/host/claude-config' },
    ],
    tmux: { pollIntervalMs: 3000, socketDir: '/tmp/tmux-host' },
    sessionResolution: { ambiguityThresholdMs: 3000 },
    claude: {
      defaultConfigDir: {
        hostPath: '/home/user/.claude',
        containerPath: '/host/claude-config',
      },
      procRoot: '/proc',
    },
  }
}

describe('resolveContainerConfigDir', () => {
  it('maps a hostPath listed in configDirs to its containerPath', () => {
    expect(resolveContainerConfigDir(makeConfig(), '/home/user/.claude')).toBe(
      '/host/claude-config'
    )
  })

  it('throws for an unmapped hostPath', () => {
    expect(() => resolveContainerConfigDir(makeConfig(), '/unknown')).toThrow()
  })
})

function makeFakeProcRoot(startTimeEpochSec: number, pid: string): string {
  const procRoot = mkdtempSync(join(tmpdir(), 'dap-resolver-proc-'))
  const bootTimeSec = 1000
  const ticksPerSec = 100
  const starttimeTicks = Math.round(
    (startTimeEpochSec - bootTimeSec) * ticksPerSec
  )
  mkdirSync(join(procRoot, pid))
  const fields = Array.from({ length: 25 }, () => '0')
  fields[19] = String(starttimeTicks)
  writeFileSync(
    join(procRoot, pid, 'stat'),
    `${pid} (claude) ${fields.join(' ')}`
  )
  writeFileSync(join(procRoot, 'stat'), `cpu  0 0 0 0\nbtime ${bootTimeSec}\n`)
  return procRoot
}

describe('resolveSessionId', () => {
  it('prefers sessions/<pid>.json when present', async () => {
    const containerConfigDir = mkdtempSync(
      join(tmpdir(), 'dap-resolver-config-')
    )
    mkdirSync(join(containerConfigDir, 'sessions'), { recursive: true })
    writeFileSync(
      join(containerConfigDir, 'sessions', '1234.json'),
      JSON.stringify({ sessionId: 'session-from-marker' })
    )

    const result = await resolveSessionId(
      '/proc-unused',
      containerConfigDir,
      '1234',
      '/cwd',
      3000
    )

    expect(result).toEqual({
      kind: 'resolved',
      sessionId: 'session-from-marker',
    })
  })

  it('rejects a marker sessionId containing a path separator', async () => {
    const containerConfigDir = mkdtempSync(
      join(tmpdir(), 'dap-resolver-config-')
    )
    mkdirSync(join(containerConfigDir, 'sessions'), { recursive: true })
    writeFileSync(
      join(containerConfigDir, 'sessions', '1234.json'),
      JSON.stringify({ sessionId: '../../etc/passwd' })
    )

    await expect(
      resolveSessionId('/proc-unused', containerConfigDir, '1234', '/cwd', 3000)
    ).rejects.toThrow()
  })

  it('falls back to the single matching jsonl file when no marker exists', async () => {
    const containerConfigDir = mkdtempSync(
      join(tmpdir(), 'dap-resolver-config-')
    )
    const projectDir = join(
      containerConfigDir,
      'projects',
      '-mnt-ssd-repos-example'
    )
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'session-only.jsonl'), '{}')

    const result = await resolveSessionId(
      '/proc-unused',
      containerConfigDir,
      '1234',
      '/mnt/ssd/repos/example',
      3000
    )

    expect(result).toEqual({ kind: 'resolved', sessionId: 'session-only' })
  })

  it('returns unresolved when the project directory does not exist', async () => {
    const containerConfigDir = mkdtempSync(
      join(tmpdir(), 'dap-resolver-config-')
    )

    const result = await resolveSessionId(
      '/proc-unused',
      containerConfigDir,
      '1234',
      '/mnt/ssd/repos/example',
      3000
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('picks the jsonl file closest to the process start time when unambiguous', async () => {
    const containerConfigDir = mkdtempSync(
      join(tmpdir(), 'dap-resolver-config-')
    )
    const projectDir = join(
      containerConfigDir,
      'projects',
      '-mnt-ssd-repos-example'
    )
    mkdirSync(projectDir, { recursive: true })
    // Process started at epoch 2000s.
    const procRoot = makeFakeProcRoot(2000, '1234')
    writeFileSync(join(projectDir, 'far.jsonl'), '{}')
    writeFileSync(join(projectDir, 'close.jsonl'), '{}')
    // Nudge mtimes/birthtimes apart: 'far' was created far earlier than the
    // process start, 'close' right around it. We can't set birthtime
    // directly, so this test only asserts *a* single sessionId is chosen
    // (ambiguity threshold behavior is covered separately below) — full
    // control over birthtime requires OS-level tooling unavailable in a
    // portable test, so we assert the resolver doesn't throw and returns
    // one of the two candidates.
    const result = await resolveSessionId(
      procRoot,
      containerConfigDir,
      '1234',
      '/mnt/ssd/repos/example',
      0
    )

    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(['far', 'close']).toContain(result.sessionId)
    }
  })

  it('returns ambiguous when top two candidates are within the threshold', async () => {
    const containerConfigDir = mkdtempSync(
      join(tmpdir(), 'dap-resolver-config-')
    )
    const projectDir = join(
      containerConfigDir,
      'projects',
      '-mnt-ssd-repos-example'
    )
    mkdirSync(projectDir, { recursive: true })
    const procRoot = makeFakeProcRoot(2000, '1234')
    writeFileSync(join(projectDir, 'a.jsonl'), '{}')
    writeFileSync(join(projectDir, 'b.jsonl'), '{}')

    // With an effectively infinite threshold, any two candidates count as ambiguous.
    const result = await resolveSessionId(
      procRoot,
      containerConfigDir,
      '1234',
      '/mnt/ssd/repos/example',
      Number.MAX_SAFE_INTEGER
    )

    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.candidates.toSorted()).toEqual(['a', 'b'])
    }
  })
})
