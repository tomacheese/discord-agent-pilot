import { describe, expect, it, vi } from 'vitest'
import type { Message, OmitPartialGroupDMChannel } from 'discord.js'
import type { Config } from '../config/schema.js'
import { createDiscordClient } from './client.js'

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

function makeMessage(
  userId: string,
  // eslint-disable-next-line unicorn/consistent-boolean-name -- mirrors discord.js's `Message.author.bot` field name
  bot: boolean
): OmitPartialGroupDMChannel<Message> {
  return {
    author: { id: userId, bot },
  } as unknown as OmitPartialGroupDMChannel<Message>
}

describe('createDiscordClient', () => {
  it('invokes onAllowedMessage for a message from an allowed user', () => {
    const onAllowedMessage = vi.fn()
    const client = createDiscordClient(makeConfig(['user-1']), {
      onAllowedMessage,
    })

    client.emit('messageCreate', makeMessage('user-1', false))

    expect(onAllowedMessage).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onAllowedMessage for a message from a disallowed user', () => {
    const onAllowedMessage = vi.fn()
    const client = createDiscordClient(makeConfig(['user-1']), {
      onAllowedMessage,
    })

    client.emit('messageCreate', makeMessage('user-2', false))

    expect(onAllowedMessage).not.toHaveBeenCalled()
  })

  it('does not invoke onAllowedMessage for a message from a bot', () => {
    const onAllowedMessage = vi.fn()
    const client = createDiscordClient(makeConfig(['user-1']), {
      onAllowedMessage,
    })

    client.emit('messageCreate', makeMessage('user-1', true))

    expect(onAllowedMessage).not.toHaveBeenCalled()
  })
})
