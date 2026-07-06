import { describe, expect, it } from 'vitest'
import type { Config } from '../config/schema'
import { isAllowedUser } from './permissions'

function makeConfig(allowedUserIds: string[]): Config {
  return {
    guildId: 'guild-1',
    parentChannel: { type: 'forum', id: 'channel-1' },
    allowedUserIds,
    workspaceRoots: ['/mnt/ssd/repos'],
    configDirs: [],
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

describe('isAllowedUser', () => {
  it('returns true for an allowed user', () => {
    expect(isAllowedUser('user-1', makeConfig(['user-1', 'user-2']))).toBe(true)
  })

  it('returns false for a user not in allowedUserIds', () => {
    expect(isAllowedUser('user-3', makeConfig(['user-1', 'user-2']))).toBe(
      false
    )
  })
})
