import type { ForumChannel, ThreadChannel } from 'discord.js'
import type { ParentChannel } from './parent-channel.js'

/** ParentChannel implementation backed by a Discord forum channel. */
export class ForumParentChannel implements ParentChannel {
  constructor(private readonly channel: ForumChannel) {}

  async createSessionThread(title: string): Promise<ThreadChannel> {
    return this.channel.threads.create({
      name: title,
      message: { content: `Session thread: ${title}` },
    })
  }
}
