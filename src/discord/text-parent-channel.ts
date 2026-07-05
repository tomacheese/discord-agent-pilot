import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import type { ParentChannel } from './parent-channel'

/** ParentChannel implementation backed by a Discord text channel. */
export class TextParentChannel implements ParentChannel {
  constructor(private readonly channel: TextChannel) {}

  async createSessionThread(title: string): Promise<ThreadChannel> {
    return this.channel.threads.create({
      name: title,
      type: ChannelType.PublicThread,
    })
  }
}
