import { type ChildProcess, spawn } from 'node:child_process'
import { Client, GatewayIntentBits, type ForumChannel } from 'discord.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createParentChannel } from './discord/parent-channel.js'
import { createDiscordClient } from './discord/client.js'
import type { Config } from './config/schema.js'

const PORT = 34_567
const BASE_URL = `http://127.0.0.1:${PORT}`
const BOT_TOKEN = 'test-bot-token'

/** Holds the spawned fauxcord process so it survives across `beforeAll`/`afterAll`. */
const fauxcordHandle: { process?: ChildProcess } = {}

/** Polls `${BASE_URL}/_mock/health` until it responds or `timeoutMs` elapses. */
async function waitForFauxcord(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/_mock/health`)
      if (response.ok) return
    } catch {
      // Not up yet; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('fauxcord did not become healthy in time')
}

beforeAll(async () => {
  fauxcordHandle.process = spawn(
    'pnpm',
    ['exec', 'tsx', 'node_modules/fauxcord/src/index.ts'],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DB_PATH: ':memory:',
      },
      stdio: 'ignore',
    }
  )
  await waitForFauxcord(15_000)
}, 20_000)

afterAll(() => {
  fauxcordHandle.process?.kill()
})

async function setupFauxcordGuild(): Promise<{
  guildId: string
  forumChannelId: string
}> {
  const response = await fetch(`${BASE_URL}/_test/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: `Bot ${BOT_TOKEN}`,
      user: { username: 'TestBot' },
      guilds: [
        {
          name: 'Test Guild',
          channels: [{ name: 'sessions', type: 15 }],
        },
      ],
    }),
  })
  const body = (await response.json()) as {
    guilds: { id: string; channels: { id: string; type: number }[] }[]
  }
  const guild = body.guilds[0]
  const forumChannel = guild.channels.find((c) => c.type === 15)
  if (!forumChannel)
    throw new Error('fauxcord did not create the forum channel')
  return { guildId: guild.id, forumChannelId: forumChannel.id }
}

describe('fauxcord integration', () => {
  it('creates a real forum thread via ParentChannel/createSessionThread', async () => {
    const { guildId, forumChannelId } = await setupFauxcordGuild()

    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: { api: `${BASE_URL}/api` },
    })
    client.rest.setToken(BOT_TOKEN)

    // This test never calls `client.login()` (fauxcord mocks the REST API
    // only, not the Gateway), so `client.guilds.cache` is never populated by
    // a READY event. discord.js's channel/thread construction resolves the
    // owning guild via `client.guilds.cache.get(guildId)`; without this
    // explicit fetch, `client.channels.fetch()` returns `null` (no cached
    // guild to attach the channel to) and thread creation fails the same
    // way. Fetching the guild first populates that cache.
    await client.guilds.fetch(guildId)

    const channel = (await client.channels.fetch(
      forumChannelId
    )) as ForumChannel
    const parentChannel = createParentChannel(channel, 'forum')

    const thread = await parentChannel.createSessionThread('session-abc')

    expect(thread.name).toBe('session-abc')
  })

  it('only forwards messages from allowed users through the assembled client', () => {
    const config: Config = {
      guildId: 'guild-1',
      parentChannel: { type: 'forum', id: 'channel-1' },
      allowedUserIds: ['allowed-user'],
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
    const onAllowedMessage = vi.fn()
    const client = createDiscordClient(config, { onAllowedMessage })

    client.emit('messageCreate', {
      author: { id: 'blocked-user', bot: false },
    } as never)
    client.emit('messageCreate', {
      author: { id: 'allowed-user', bot: false },
    } as never)

    expect(onAllowedMessage).toHaveBeenCalledTimes(1)
  })
})
