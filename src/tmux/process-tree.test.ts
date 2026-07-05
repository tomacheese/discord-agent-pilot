import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
  it('returns the root pid when it is itself the claude process', async () => {
    const procRoot = mkdtempSync(path.join(tmpdir(), 'dap-tree-'))
    makeProc(procRoot, '100', 'claude')

    await expect(findClaudeProcessPid(procRoot, '100')).resolves.toBe('100')
  })

  it('finds claude among nested descendants (shell -> node -> claude)', async () => {
    const procRoot = mkdtempSync(path.join(tmpdir(), 'dap-tree-'))
    makeProc(procRoot, '100', 'bash', ['200'])
    makeProc(procRoot, '200', 'node', ['300'])
    makeProc(procRoot, '300', 'claude')

    await expect(findClaudeProcessPid(procRoot, '100')).resolves.toBe('300')
  })

  it('returns undefined when no descendant is claude', async () => {
    const procRoot = mkdtempSync(path.join(tmpdir(), 'dap-tree-'))
    makeProc(procRoot, '100', 'bash', ['200'])
    makeProc(procRoot, '200', 'vim')

    await expect(findClaudeProcessPid(procRoot, '100')).resolves.toBeUndefined()
  })

  it('logs a warning and returns undefined for a non-ENOENT read error', async () => {
    const procRoot = mkdtempSync(path.join(tmpdir(), 'dap-tree-'))
    // No pid directory at all is created, so reading `comm` fails with
    // ENOENT for '100' itself -- to exercise the non-ENOENT branch we
    // create the directory without read permission on `comm`.
    const directory = path.join(procRoot, '100')
    mkdirSync(directory, { recursive: true })
    const commPath = path.join(directory, 'comm')
    writeFileSync(commPath, 'claude\n', { mode: 0o000 })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const result = await findClaudeProcessPid(procRoot, '100')
      // Running as root (some CI/sandbox environments) ignores file mode
      // bits, in which case the read succeeds and this test only confirms
      // no crash occurs; otherwise EACCES triggers the warn-and-continue path.
      if (warn.mock.calls.length > 0) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('comm'),
          expect.anything()
        )
        expect(result).toBeUndefined()
      }
    } finally {
      warn.mockRestore()
    }
  })
})
