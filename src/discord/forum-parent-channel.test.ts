import { describe, expect, it, vi } from 'vitest'
import type { ForumChannel } from 'discord.js'
import { ForumParentChannel } from './forum-parent-channel'

describe('ForumParentChannel.archiveThread', () => {
  it('fetches the thread by id and archives it', async () => {
    const setArchived = vi.fn().mockResolvedValue(undefined)
    const fetch = vi.fn().mockResolvedValue({ setArchived })
    const fakeForumChannel = {
      threads: { fetch },
    } as unknown as ForumChannel

    const parentChannel = new ForumParentChannel(fakeForumChannel)
    await parentChannel.archiveThread('thread-1')

    expect(fetch).toHaveBeenCalledWith('thread-1')
    expect(setArchived).toHaveBeenCalledWith(true)
  })

  it('does nothing when the thread no longer exists', async () => {
    const fetch = vi.fn().mockResolvedValue(null)
    const fakeForumChannel = {
      threads: { fetch },
    } as unknown as ForumChannel

    const parentChannel = new ForumParentChannel(fakeForumChannel)

    await expect(
      parentChannel.archiveThread('thread-1')
    ).resolves.toBeUndefined()
  })
})
