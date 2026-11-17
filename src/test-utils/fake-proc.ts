import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Creates an empty directory usable as a fake `/proc` root. */
export function makeFakeProcRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'dap-proc-'))
}

/**
 * Writes the `/proc/<pid>` files this project reads: `comm`, `stat` (with
 * `startTicks` as field 22) and, when `children` is non-empty,
 * `task/<pid>/children`.
 */
export function writeFakeProcess(
  procRoot: string,
  pid: string,
  options: { comm: string; startTicks: number; children?: string[] }
): void {
  const directory = path.join(procRoot, pid)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'comm'), `${options.comm}\n`)

  const fields = Array.from({ length: 50 }, () => '0')
  fields[0] = 'S'
  fields[19] = String(options.startTicks)
  writeFileSync(
    path.join(directory, 'stat'),
    `${pid} (${options.comm}) ${fields.join(' ')}`
  )

  const children = options.children ?? []
  if (children.length > 0) {
    mkdirSync(path.join(directory, 'task', pid), { recursive: true })
    writeFileSync(
      path.join(directory, 'task', pid, 'children'),
      `${children.join(' ')} \n`
    )
  }
}
