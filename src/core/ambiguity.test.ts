import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../config/schema.js'
import {
  AmbiguityTracker,
  promptSessionIdSelection,
  type PromptChannel,
} from './ambiguity.js'

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

describe('AmbiguityTracker', () => {
  it('tracks pending state per tmux session + pane pid', () => {
    const tracker = new AmbiguityTracker()
    expect(tracker.isPending('tmux-1', '100')).toBe(false)

    tracker.markPending('tmux-1', '100', ['session-a', 'session-b'])
    expect(tracker.isPending('tmux-1', '100')).toBe(true)
    expect(tracker.isPending('tmux-1', '200')).toBe(false)

    tracker.resolve('tmux-1', '100')
    expect(tracker.isPending('tmux-1', '100')).toBe(false)
  })
})

interface FakeCollectInteraction {
  user: { id: string }
  values: string[]
  reply: (options: unknown) => Promise<void>
}

function makeFakeChannel() {
  let collectCallback:
    ((interaction: FakeCollectInteraction) => void) | undefined
  let endCallback: ((collected: unknown, reason: string) => void) | undefined
  const collector = {
    on: vi.fn(
      (
        event: string,
        callback:
          | typeof collectCallback
          | ((collected: unknown, reason: string) => void)
      ) => {
        if (event === 'collect') {
          collectCallback = callback as typeof collectCallback
        } else if (event === 'end') {
          endCallback = callback as typeof endCallback
        }
      }
    ),
    // Mirrors discord.js's real Collector: stopping it fires its own 'end'
    // event with the given reason, same as the production code relies on.
    stop: vi.fn((reason?: string) => {
      endCallback?.(undefined, reason ?? 'user')
    }),
  }
  const message = {
    createMessageComponentCollector: vi.fn().mockReturnValue(collector),
  }
  const channel: PromptChannel = {
    send: vi.fn().mockResolvedValue(message),
  }
  return {
    channel,
    collector,
    emitCollect: (interaction: FakeCollectInteraction) =>
      collectCallback?.(interaction),
    emitEnd: (reason: string) => endCallback?.(undefined, reason),
  }
}

describe('promptSessionIdSelection', () => {
  it('resolves with the sessionId selected by an allowed user', async () => {
    const { channel, collector, emitCollect } = makeFakeChannel()
    const resultPromise = promptSessionIdSelection(
      channel,
      ['session-a', 'session-b'],
      makeConfig(['user-1'])
    )

    // Flush the microtask queue so the promise-executor's `await
    // channel.send(...)` continuation runs and registers the collector
    // before we emit the first collect event.
    await Promise.resolve()
    emitCollect({
      user: { id: 'user-1' },
      values: ['session-b'],
      reply: vi.fn(),
    })

    await expect(resultPromise).resolves.toBe('session-b')
    // The collector must be stopped once a valid selection is made, rather
    // than left running until AMBIGUITY_PROMPT_TIMEOUT_MS elapses.
    expect(collector.stop).toHaveBeenCalled()
  })

  it('rejects a disallowed user selection with an ephemeral reply and keeps waiting', async () => {
    const { channel, emitCollect } = makeFakeChannel()
    const resultPromise = promptSessionIdSelection(
      channel,
      ['session-a'],
      makeConfig(['user-1'])
    )
    const reply = vi.fn().mockResolvedValue(undefined)

    // Flush the microtask queue so the promise-executor's `await
    // channel.send(...)` continuation runs and registers the collector
    // before we emit the first collect event.
    await Promise.resolve()
    emitCollect({ user: { id: 'user-2' }, values: ['session-a'], reply })
    // Give the microtask queue a tick so the reply promise settles before we assert.
    await Promise.resolve()

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true })
    )

    emitCollect({
      user: { id: 'user-1' },
      values: ['session-a'],
      reply: vi.fn(),
    })
    await expect(resultPromise).resolves.toBe('session-a')
  })

  it('resolves to undefined when the collector times out without a selection', async () => {
    const { channel, emitEnd } = makeFakeChannel()
    const resultPromise = promptSessionIdSelection(
      channel,
      ['session-a'],
      makeConfig(['user-1'])
    )

    // Flush the microtask queue so the promise-executor's `await
    // channel.send(...)` continuation runs and registers the collector
    // before we emit the timeout.
    await Promise.resolve()
    emitEnd('time')

    await expect(resultPromise).resolves.toBeUndefined()
  })
})
