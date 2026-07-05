import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findClaudeProcessPid } from './process-tree.js'

function makeProc(
  procRoot: string,
  pid: string,
  comm: string,
  children: string[] = []
): void {
  const directory = path.join(procRoot, pid)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'comm'), `${comm}\n`)
  if (children.length > 0) {
    mkdirSync(path.join(directory, 'task', pid), { recursive: true })
    writeFileSync(
      path.join(directory, 'task', pid, 'children'),
      `${children.join(' ')} \n`
    )
  }
}

describe('findClaudeProcessPid', () => {
  it('returns the root pid when it is itself the claude process', () => {
    const procRoot = mkdtempSync(path.join(tmpdir(), 'dap-tree-'))
    makeProc(procRoot, '100', 'claude')

    expect(findClaudeProcessPid(procRoot, '100')).toBe('100')
  })

  it('finds claude among nested descendants (shell -> node -> claude)', () => {
    const procRoot = mkdtempSync(path.join(tmpdir(), 'dap-tree-'))
    makeProc(procRoot, '100', 'bash', ['200'])
    makeProc(procRoot, '200', 'node', ['300'])
    makeProc(procRoot, '300', 'claude')

    expect(findClaudeProcessPid(procRoot, '100')).toBe('300')
  })

  it('returns undefined when no descendant is claude', () => {
    const procRoot = mkdtempSync(path.join(tmpdir(), 'dap-tree-'))
    makeProc(procRoot, '100', 'bash', ['200'])
    makeProc(procRoot, '200', 'vim')

    expect(findClaudeProcessPid(procRoot, '100')).toBeUndefined()
  })
})
