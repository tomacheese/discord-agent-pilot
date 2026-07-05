import { Client, GatewayIntentBits, type Message } from 'discord.js'
import type { Config } from '../config/schema'
import { isAllowedUser } from './permissions'

/**
 * Handlers a caller can register on the client created by `createDiscordClient`.
 */
export interface DiscordClientHandlers {
  /**
   * Called for each non-bot message from an allowed user. Phase 1 only
   * enforces the permission filter; forwarding to `input_queue` is a
   * later phase's responsibility.
   */
  onAllowedMessage?: (message: Message) => void
}

/**
 * Creates a discord.js client and wires the allowed-user message filter.
 */
export function createDiscordClient(
  config: Config,
  handlers: DiscordClientHandlers = {}
): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.on('messageCreate', (message: Message) => {
    if (message.author.bot) return
    if (!isAllowedUser(message.author.id, config)) return
    handlers.onAllowedMessage?.(message)
  })

  return client
}
