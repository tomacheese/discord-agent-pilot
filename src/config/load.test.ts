import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './load'

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
  const directory = mkdtempSync(path.join(tmpdir(), 'dap-config-'))

  const filePath = path.join(directory, 'config.yaml')

  writeFileSync(filePath, content, 'utf8')
  return filePath
}

describe('loadConfig', () => {
  it('parses a valid config.yaml', () => {
    const configPath = writeTemporaryConfig(VALID_YAML)
    const config = loadConfig(configPath)
    expect(config.guildId).toBe('123456789012345678')
    expect(config.parentChannel).toEqual({
      type: 'forum',
      id: '234567890123456789',
    })
    expect(config.allowedUserIds).toEqual(['345678901234567890'])
    expect(config.tmux.pollIntervalMs).toBe(3000)
  })

  it('throws when a required field is missing', () => {
    const configPath = writeTemporaryConfig('guildId: "123456789012345678"\n')
    expect(() => loadConfig(configPath)).toThrow()
  })

  it('throws when allowedUserIds is empty', () => {
    const invalid = VALID_YAML.replace(
      'allowedUserIds:\n  - "345678901234567890"',
      'allowedUserIds: []'
    )
    const configPath = writeTemporaryConfig(invalid)
    expect(() => loadConfig(configPath)).toThrow()
  })

  it('leaves discordToken undefined when omitted', () => {
    const configPath = writeTemporaryConfig(VALID_YAML)
    const config = loadConfig(configPath)
    expect(config.discordToken).toBeUndefined()
  })

  it('parses discordToken when present', () => {
    const withToken = `guildId: "123456789012345678"\ndiscordToken: "fake-token"\n${VALID_YAML.replace('guildId: "123456789012345678"\n', '')}`
    const configPath = writeTemporaryConfig(withToken)
    const config = loadConfig(configPath)
    expect(config.discordToken).toBe('fake-token')
  })
})
