import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readBootTimeEpochMs,
  readProcessCwd,
  readProcessEnviron,
  readProcessStartTicks,
} from './proc.js'

function makeFakeProcRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'dap-proc-'))
}

describe('readProcessCwd', () => {
  it('resolves the cwd symlink target', () => {
    const procRoot = makeFakeProcRoot()
    const targetDirectory = mkdtempSync(path.join(tmpdir(), 'dap-cwd-'))
    mkdirSync(path.join(procRoot, '1234'))
    symlinkSync(targetDirectory, path.join(procRoot, '1234', 'cwd'))

    expect(readProcessCwd(procRoot, '1234')).toBe(targetDirectory)
  })
})

describe('readProcessEnviron', () => {
  it('parses NUL-separated KEY=VALUE entries', () => {
    const procRoot = makeFakeProcRoot()
    mkdirSync(path.join(procRoot, '1234'))
    writeFileSync(
      path.join(procRoot, '1234', 'environ'),
      'CLAUDE_CONFIG_DIR=/home/user/.claude\0PATH=/usr/bin\0'
    )

    const environment = readProcessEnviron(procRoot, '1234')

    expect(environment.CLAUDE_CONFIG_DIR).toBe('/home/user/.claude')
    expect(environment.PATH).toBe('/usr/bin')
  })
})

describe('readProcessStartTicks and readBootTimeEpochMs', () => {
  it('parses field 22 (starttime) from stat, tolerating a comm with spaces', () => {
    const procRoot = makeFakeProcRoot()
    mkdirSync(path.join(procRoot, '1234'))
    // comm field intentionally contains a space and parens to exercise the
    // "parse relative to the last ')'" logic.
    const fields = Array.from({ length: 50 }, () => '0')
    fields[0] = 'S' // state (field 3 overall, index 0 after comm)
    // Layout after "<pid> (comm) ": state ppid pgrp session tty_nr tpgid flags
    // minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
    // num_threads itrealvalue starttime ...
    // starttime is index 19 in this array (0-based, after state).
    fields[19] = '123456'
    const statLine = `1234 (some proc) ${fields.join(' ')}`
    writeFileSync(path.join(procRoot, '1234', 'stat'), statLine)
    writeFileSync(path.join(procRoot, 'stat'), 'cpu  0 0 0 0\nbtime 1700000000\n')

    expect(readProcessStartTicks(procRoot, '1234')).toBe(123_456)
    expect(readBootTimeEpochMs(procRoot)).toBe(1_700_000_000 * 1000)
  })
})
