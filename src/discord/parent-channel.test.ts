import { describe, expect, it, vi } from 'vitest'
import type { ForumChannel, TextChannel } from 'discord.js'
import { createParentChannel } from './parent-channel'

describe('createParentChannel', () => {
  it('creates a forum thread with the given title via ForumParentChannel', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'thread-1', name: 'my-session' })
    const fakeForumChannel = { threads: { create } } as unknown as ForumChannel

    const parentChannel = createParentChannel(fakeForumChannel, 'forum')
    const thread = await parentChannel.createSessionThread('my-session')

    expect(thread.id).toBe('thread-1')
    const expectedMessage = expect.objectContaining({
      content: expect.any(String),
    })
    const expectedOptions = expect.objectContaining({
      name: 'my-session',
      message: expectedMessage,
    })
    expect(create).toHaveBeenCalledWith(expectedOptions)
  })

  it('creates a text-channel thread with the given title via TextParentChannel', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'thread-2', name: 'my-session' })
    const fakeTextChannel = { threads: { create } } as unknown as TextChannel

    const parentChannel = createParentChannel(fakeTextChannel, 'text')
    const thread = await parentChannel.createSessionThread('my-session')

    expect(thread.id).toBe('thread-2')
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-session' })
    )
  })
})
