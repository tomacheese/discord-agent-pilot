import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../config/schema'
import {
  findLatestJsonlForSessionId,
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
 * Builds a fake `/proc/<pid>/stat` line whose 22nd field (process start time
 * in clock ticks since boot, index 19 counting from the field right after
 * `comm`'s closing `)` — see `readProcessStartTicks` in `src/tmux/proc.ts`,
 * which lands this at index 21 of this raw field array) is `startTicks`.
 */
function buildFakeStat(startTicks: number): string {
  const fields = Array.from({ length: 52 }, () => '0')
  fields[0] = '100'
  fields[1] = '(node)'
  fields[2] = 'S'
  fields[21] = String(startTicks)
  return fields.join(' ')
}

/**
 * Writes a fake `${procRoot}/stat` + `${procRoot}/<pid>/stat` pair that
 * reconstructs `processStartMs` (an arbitrary real epoch-ms timestamp, e.g.
 * a file's real `birthtimeMs`) as process `pid`'s start time, accurate to
 * within one clock tick (10ms at 100 ticks/sec). Real file birthtimes can't
 * be backdated from userspace, so tests instead fake the *process* start
 * time to line up with a real, already-observed file birthtime.
 */
async function writeFakeProcessStart(
  procRoot: string,
  pid: string,
  processStartMs: number
): Promise<void> {
  await mkdir(path.join(procRoot, pid), { recursive: true })
  const bootEpochSeconds = Math.floor(processStartMs / 1000)
  const ticks = Math.round((processStartMs - bootEpochSeconds * 1000) / 10)
  // readBootTimeEpochMs (src/tmux/proc.ts) reads `${procRoot}/stat`'s
  // `btime` line, not a `${procRoot}/uptime` file — this must match that
  // contract or resolveSessionId's ENOENT on this file will fail the test.
  await writeFile(
    path.join(procRoot, 'stat'),
    `cpu  0 0 0 0\nbtime ${bootEpochSeconds}\n`
  )
  await writeFile(path.join(procRoot, pid, 'stat'), buildFakeStat(ticks))
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

    // Birthtime can't be backdated from userspace, so create "far" first,
    // wait a real interval, then create "close" — this produces a genuine,
    // non-flaky birthtime gap between the two files.
    await writeFile(farPath, '')
    await new Promise((resolve) => setTimeout(resolve, 50))
    await writeFile(closePath, '')

    const closeStats = await stat(closePath)
    await writeFakeProcessStart(procRoot, '100', closeStats.birthtimeMs)

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      cwd,
      10
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

    // Both files are created back-to-back with no artificial delay, so
    // their real birthtimes naturally land within a few ms of each other —
    // well inside the generous threshold below.
    const statsA = await stat(pathA)
    await writeFakeProcessStart(procRoot, '100', statsA.birthtimeMs)

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      '/mnt/ssd/repos/example',
      1000
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

  it('excludes an entry outside the ambiguity threshold of the best match, even when it is the second-closest', async () => {
    const cwd = '/mnt/ssd/repos/example'
    const directoryName = '-mnt-ssd-repos-example'
    const farPath = path.join(
      containerConfigDirectory,
      'projects',
      directoryName,
      'session-far.jsonl'
    )
    await mkdir(path.dirname(farPath), { recursive: true })

    // "far" is created well before the other two, so its birthtime sits
    // outside the threshold even though it's numerically the "second"
    // closest to the process start time once sorted.
    await writeFile(farPath, '')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const pathA = await writeJsonlFile(directoryName, 'session-a')
    const pathB = await writeJsonlFile(directoryName, 'session-b')

    const statsA = await stat(pathA)
    await writeFakeProcessStart(procRoot, '100', statsA.birthtimeMs)

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      cwd,
      100
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

  it('caps ambiguous candidates at 25 to fit the Discord select menu even when more entries are within the threshold', async () => {
    const directoryName = '-mnt-ssd-repos-many'
    const paths = await Promise.all(
      Array.from({ length: 30 }, async (_, index) =>
        writeJsonlFile(
          directoryName,
          `session-${String(index).padStart(2, '0')}`
        )
      )
    )

    const firstStats = await stat(paths[0])
    await writeFakeProcessStart(procRoot, '100', firstStats.birthtimeMs)

    const result = await resolveSessionId(
      procRoot,
      containerConfigDirectory,
      '100',
      '/mnt/ssd/repos/example',
      // Generous threshold: all 30 files were created back-to-back, so
      // their real birthtimes land within a few ms of each other.
      10_000
    )

    expect(result.kind).toBe('ambiguous')
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous')
    expect(result.candidates).toHaveLength(25)
  })
})

describe('findLatestJsonlForSessionId', () => {
  let projectsRoot: string

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'projects-root-'))
  })

  afterEach(async () => {
    await rm(projectsRoot, { recursive: true, force: true })
  })

  it('returns undefined when no matching file exists anywhere', async () => {
    await mkdir(path.join(projectsRoot, 'project-a'))
    await writeFile(
      path.join(projectsRoot, 'project-a', 'other-session.jsonl'),
      ''
    )

    const result = await findLatestJsonlForSessionId(
      projectsRoot,
      'target-session'
    )

    expect(result).toBeUndefined()
  })

  it('returns the single match when only one directory has the file', async () => {
    await mkdir(path.join(projectsRoot, 'project-a'))
    const expected = path.join(
      projectsRoot,
      'project-a',
      'target-session.jsonl'
    )
    await writeFile(expected, '')

    const result = await findLatestJsonlForSessionId(
      projectsRoot,
      'target-session'
    )

    expect(result).toBe(expected)
  })

  it('returns the file with the most recent mtime when the same sessionId file exists in multiple directories', async () => {
    await mkdir(path.join(projectsRoot, 'project-old'))
    await mkdir(path.join(projectsRoot, 'project-new'))
    const oldFile = path.join(
      projectsRoot,
      'project-old',
      'target-session.jsonl'
    )
    const newFile = path.join(
      projectsRoot,
      'project-new',
      'target-session.jsonl'
    )
    await writeFile(oldFile, '')
    await writeFile(newFile, '')
    const older = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-01-02T00:00:00Z')
    await utimes(oldFile, older, older)
    await utimes(newFile, newer, newer)

    const result = await findLatestJsonlForSessionId(
      projectsRoot,
      'target-session'
    )

    expect(result).toBe(newFile)
  })

  it('excludes a candidate whose stat() fails (e.g. a broken symlink) and returns the remaining candidate', async () => {
    await mkdir(path.join(projectsRoot, 'project-broken'))
    await mkdir(path.join(projectsRoot, 'project-ok'))
    const brokenLink = path.join(
      projectsRoot,
      'project-broken',
      'target-session.jsonl'
    )
    const okFile = path.join(projectsRoot, 'project-ok', 'target-session.jsonl')
    await symlink(path.join(projectsRoot, 'does-not-exist'), brokenLink)
    await writeFile(okFile, '')

    const result = await findLatestJsonlForSessionId(
      projectsRoot,
      'target-session'
    )

    expect(result).toBe(okFile)
  })
})
