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

describe('ForumParentChannel.updateThreadStatus', () => {
  it('fetches the thread, fetches its starter message, and edits it', async () => {
    const edit = vi.fn().mockResolvedValue(undefined)
    const fetchStarterMessage = vi.fn().mockResolvedValue({ edit })
    const fetch = vi.fn().mockResolvedValue({ fetchStarterMessage })
    const fakeForumChannel = {
      threads: { fetch },
    } as unknown as ForumChannel

    const parentChannel = new ForumParentChannel(fakeForumChannel)
    await parentChannel.updateThreadStatus('thread-1', 'new content')

    expect(fetch).toHaveBeenCalledWith('thread-1')
    expect(edit).toHaveBeenCalledWith('new content')
  })

  it('does nothing when the thread no longer exists', async () => {
    const fetch = vi.fn().mockResolvedValue(null)
    const fakeForumChannel = {
      threads: { fetch },
    } as unknown as ForumChannel

    const parentChannel = new ForumParentChannel(fakeForumChannel)

    await expect(
      parentChannel.updateThreadStatus('thread-1', 'new content')
    ).resolves.toBeUndefined()
  })

  it('does nothing when the starter message no longer exists', async () => {
    const fetchStarterMessage = vi.fn().mockResolvedValue(null)
    const fetch = vi.fn().mockResolvedValue({ fetchStarterMessage })
    const fakeForumChannel = {
      threads: { fetch },
    } as unknown as ForumChannel

    const parentChannel = new ForumParentChannel(fakeForumChannel)

    await expect(
      parentChannel.updateThreadStatus('thread-1', 'new content')
    ).resolves.toBeUndefined()
  })
})
