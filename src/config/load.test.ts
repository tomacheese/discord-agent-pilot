/* eslint-disable unicorn/import-style */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './load.js'
/* eslint-enable unicorn/import-style */

const VALID_YAML = `
guildId: "123456789012345678"
parentChannel:
  type: forum
  id: "234567890123456789"
allowedUserIds:
  - "345678901234567890"
workspaceRoots:
  - "/mnt/ssd/repos"
configDirs:
  - hostPath: "/home/user/.claude"
    containerPath: "/host/claude-config"
tmux:
  pollIntervalMs: 3000
  socketDir: "/tmp/tmux-host"
sessionResolution:
  ambiguityThresholdMs: 3000
claude:
  defaultConfigDir:
    hostPath: "/home/user/.claude"
    containerPath: "/host/claude-config"
  procRoot: "/proc"
`

function writeTemporaryConfig(content: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const directory = mkdtempSync(join(tmpdir(), 'dap-config-'))
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const filePath = join(directory, 'config.yaml')
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  writeFileSync(filePath, content, 'utf8')
  return filePath as string
}

describe('loadConfig', () => {
  it('parses a valid config.yaml', () => {
    const path = writeTemporaryConfig(VALID_YAML)
    const config = loadConfig(path)
    expect(config.guildId).toBe('123456789012345678')
    expect(config.parentChannel).toEqual({ type: 'forum', id: '234567890123456789' })
    expect(config.allowedUserIds).toEqual(['345678901234567890'])
    expect(config.tmux.pollIntervalMs).toBe(3000)
  })

  it('throws when a required field is missing', () => {
    const path = writeTemporaryConfig('guildId: "123456789012345678"\n')
    expect(() => loadConfig(path)).toThrow()
  })

  it('throws when allowedUserIds is empty', () => {
    const invalid = VALID_YAML.replace(
      'allowedUserIds:\n  - "345678901234567890"',
      'allowedUserIds: []'
    )
    const path = writeTemporaryConfig(invalid)
    expect(() => loadConfig(path)).toThrow()
  })
})
