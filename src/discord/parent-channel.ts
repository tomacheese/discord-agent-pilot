import type { ForumChannel, TextChannel, ThreadChannel } from 'discord.js'
import { ForumParentChannel } from './forum-parent-channel'
import { TextParentChannel } from './text-parent-channel'

/** Abstraction over a Discord channel that can host per-session threads. */
export interface ParentChannel {
  /** Creates a new thread named `title` for a session. */
  createSessionThread(title: string): Promise<ThreadChannel>
  /**
   * Archives the thread identified by `threadId`. Optional: only
   * `ForumParentChannel` implements this today, since Issue #31 scopes
   * auto-archive to forum parent channels; `TextParentChannel` leaves this
   * undefined.
   */
  archiveThread?(threadId: string): Promise<void>
}

/**
 * Wraps an already-fetched Discord channel in the ParentChannel
 * implementation matching `type`. Callers are responsible for fetching the
 * channel (see `config.parentChannel.id`) and passing the correct `type`
 * (`config.parentChannel.type`).
 */
export function createParentChannel(
  channel: ForumChannel | TextChannel,
  type: 'forum' | 'text'
): ParentChannel {
  if (type === 'forum') {
    return new ForumParentChannel(channel as ForumChannel)
  }
  return new TextParentChannel(channel as TextChannel)
}
