import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../config/schema'
import {
  resolveContainerConfigDirectory,
  resolveSessionId,
} from './session-id-resolver'

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

describe('resolveContainerConfigDirectory', () => {
  it('maps a hostPath listed in configDirs to its containerPath', () => {
    expect(
      resolveContainerConfigDirectory(makeConfig(), '/home/user/.claude')
    ).toBe('/host/claude-config')
  })

  it('throws for an unmapped hostPath', () => {
    expect(() =>
      resolveContainerConfigDirectory(makeConfig(), '/unknown')
    ).toThrow()
  })
})

/**
 * Builds a minimal fake `/proc/<pid>/stat` line whose 22nd field (process
 * start time in clock ticks since boot) is `0` — combined with a
 * `${procRoot}/stat` `btime` line set to "now" (written by each test above),
 * this places the fake process's start time at "now" for birthtime-diff
 * comparisons.
 */
function buildFakeStat(): string {
  const fields = Array.from({ length: 52 }, () => '0')
  fields[0] = '100'
  fields[1] = '(node)'
  fields[2] = 'S'
  return fields.join(' ')
}

describe('resolveSessionId', () => {
  let temporaryRoot: string
  let containerConfigDirectory: string
  let procRoot: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'session-id-resolver-')
    )
    containerConfigDirectory = path.join(temporaryRoot, 'claude-config')
    procRoot = path.join(temporaryRoot, 'proc')
    await mkdir(containerConfigDirectory, { recursive: true })
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  async function writeMarker(pid: string, sessionId: string): Promise<void> {
    const sessionsDirectory = path.join(containerConfigDirectory, 'sessions')
    await mkdir(sessionsDirectory, { recursive: true })
    await writeFile(
      path.join(sessionsDirectory, `${pid}.json`),
      JSON.stringify({ sessionId })
    )
  }

  async function writeJsonlFile(
    projectDirectoryName: string,
    sessionId: string,
    birthtimeSourceContent = ''
  ): Promise<string> {
    const directory = path.join(
      containerConfigDirectory,
      'projects',
      projectDirectoryName
    )
    await mkdir(directory, { recursive: true })
    const filePath = path.join(directory, `${sessionId}.jsonl`)
    await writeFile(filePath, birthtimeSourceContent)
    return filePath
  }

  it('resolves via the single jsonl file in the cwd-derived directory, replacing both dots and slashes', async () => {
    // Regression test for Issue #16: the cwd-to-directory-name conversion
    // must replace `.` as well as `/`, matching real Claude Code's own
    // slugification — a cwd like this repository's own checkout path
    // (`github.com`) previously never matched anything.
    const cwd = '/mnt/ssd/repos/github.com/tomacheese/discord-agent-pilot'
    const expectedDirectoryName =
      '-mnt-ssd-repos-github-com-tomacheese-discord-agent-pilot'
    const jsonlPath = await writeJsonlFile(
      expectedDirectoryName,
      'session-only'
    )

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      cwd,
      3000
    )

    expect(result).toEqual({
      kind: 'resolved',
      sessionId: 'session-only',
      jsonlPath,
    })
  })

  it('returns unresolved when neither the cwd-derived directory nor any other project directory has a jsonl file', async () => {
    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      '/mnt/ssd/repos/example',
      3000
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('falls back to a global search across all project directories when the cwd-derived directory is empty', async () => {
    // The cwd-derived directory itself is never created — simulates a
    // worktree cwd switch where the session's real project directory
    // (from its actual start-time cwd) is a completely different name.
    const jsonlPath = await writeJsonlFile(
      '-mnt-ssd-repos-other-project',
      'session-elsewhere'
    )

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      '/mnt/ssd/repos/example',
      3000
    )

    expect(result).toEqual({
      kind: 'resolved',
      sessionId: 'session-elsewhere',
      jsonlPath,
    })
  })

  it('resolves a marker sessionId via a global filename search when it lives outside the cwd-derived directory', async () => {
    await writeMarker('100', 'session-from-marker')
    const jsonlPath = await writeJsonlFile(
      '-mnt-ssd-repos-other-project',
      'session-from-marker'
    )

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      '/mnt/ssd/repos/example',
      3000
    )

    expect(result).toEqual({
      kind: 'resolved',
      sessionId: 'session-from-marker',
      jsonlPath,
    })
  })

  it('returns unresolved when the marker sessionId has no matching jsonl anywhere', async () => {
    await writeMarker('100', 'session-nowhere')

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      '/mnt/ssd/repos/example',
      3000
    )

    expect(result).toEqual({ kind: 'unresolved' })
  })

  it('rejects a marker sessionId containing a path separator', async () => {
    await writeMarker('100', '../evil')

    await expect(
      resolveSessionId(
        procRoot,
        containerConfigDirectory,
        '100',
        '/mnt/ssd/repos/example',
        3000
      )
    ).rejects.toThrow()
  })

  it('picks the jsonl file in the cwd-derived directory closest to process start time when unambiguous', async () => {
    const cwd = '/mnt/ssd/repos/example'
    const directoryName = '-mnt-ssd-repos-example'
    const closePath = path.join(
      containerConfigDirectory,
      'projects',
      directoryName,
      'session-close.jsonl'
    )
    const farPath = path.join(
      containerConfigDirectory,
      'projects',
      directoryName,
      'session-far.jsonl'
    )
    await mkdir(path.dirname(closePath), { recursive: true })
    await writeFile(closePath, '')
    await writeFile(farPath, '')

    // Backdate the "far" file's mtime far away from "now" (process start,
    // per the fake /proc root below, is close to "now") so the birthtime
    // heuristic clearly prefers "close" over "far" beyond the threshold.
    const farOld = new Date(Date.now() - 10 * 60 * 1000)
    const { utimes } = await import('node:fs/promises')
    await utimes(farPath, farOld, farOld)

    await mkdir(procRoot, { recursive: true })
    await mkdir(path.join(procRoot, '100'), { recursive: true })
    // readBootTimeEpochMs (src/tmux/proc.ts) reads `${procRoot}/stat`'s
    // `btime` line, not a `${procRoot}/uptime` file — this must match that
    // contract or resolveSessionId's ENOENT on this file will fail the test.
    await writeFile(
      path.join(procRoot, 'stat'),
      `cpu  0 0 0 0\nbtime ${Math.floor(Date.now() / 1000)}\n`
    )
    await writeFile(path.join(procRoot, '100', 'stat'), buildFakeStat())

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      cwd,
      3000
    )

    expect(result).toEqual({
      kind: 'resolved',
      sessionId: 'session-close',
      jsonlPath: closePath,
    })
  })

  it('returns ambiguous with jsonlPath on every candidate when a global search finds two equally-recent jsonl files', async () => {
    const pathA = await writeJsonlFile('-mnt-ssd-repos-a', 'session-a')
    const pathB = await writeJsonlFile('-mnt-ssd-repos-b', 'session-b')

    await mkdir(procRoot, { recursive: true })
    await mkdir(path.join(procRoot, '100'), { recursive: true })
    // readBootTimeEpochMs (src/tmux/proc.ts) reads `${procRoot}/stat`'s
    // `btime` line, not a `${procRoot}/uptime` file — this must match that
    // contract or resolveSessionId's ENOENT on this file will fail the test.
    await writeFile(
      path.join(procRoot, 'stat'),
      `cpu  0 0 0 0\nbtime ${Math.floor(Date.now() / 1000)}\n`
    )
    await writeFile(path.join(procRoot, '100', 'stat'), buildFakeStat())

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      '/mnt/ssd/repos/example',
      3000
    )

    expect(result.kind).toBe('ambiguous')
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous')
    expect(
      result.candidates.toSorted((a, b) =>
        a.sessionId.localeCompare(b.sessionId)
      )
    ).toEqual([
      { sessionId: 'session-a', jsonlPath: pathA },
      { sessionId: 'session-b', jsonlPath: pathB },
    ])
  })
})
