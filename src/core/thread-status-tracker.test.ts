import { describe, expect, it } from 'vitest'
import {
  THREAD_STATUS_MIN_INTERVAL_MS,
  ThreadStatusTracker,
} from './thread-status-tracker'

describe('ThreadStatusTracker', () => {
  it('returns true on the first call for a thread', () => {
    const tracker = new ThreadStatusTracker()
    expect(
      tracker.shouldUpdate(
        'thread-1',
        'content',
        1000,
        THREAD_STATUS_MIN_INTERVAL_MS
      )
    ).toBe(true)
  })

  it('returns false when the content is unchanged, regardless of elapsed time', () => {
    const tracker = new ThreadStatusTracker()
    tracker.recordUpdate('thread-1', 'content', 1000)
    expect(
      tracker.shouldUpdate(
        'thread-1',
        'content',
        1000 + THREAD_STATUS_MIN_INTERVAL_MS + 1,
        THREAD_STATUS_MIN_INTERVAL_MS
      )
    ).toBe(false)
  })

  it('returns true when content changed and the debounce interval has elapsed', () => {
    const tracker = new ThreadStatusTracker()
    tracker.recordUpdate('thread-1', 'old', 1000)
    expect(
      tracker.shouldUpdate(
        'thread-1',
        'new',
        1000 + THREAD_STATUS_MIN_INTERVAL_MS,
        THREAD_STATUS_MIN_INTERVAL_MS
      )
    ).toBe(true)
  })

  it('returns false when content changed but the debounce interval has not elapsed', () => {
    const tracker = new ThreadStatusTracker()
    tracker.recordUpdate('thread-1', 'old', 1000)
    expect(
      tracker.shouldUpdate(
        'thread-1',
        'new',
        1000 + THREAD_STATUS_MIN_INTERVAL_MS - 1,
        THREAD_STATUS_MIN_INTERVAL_MS
      )
    ).toBe(false)
  })

  it('tracks each thread independently', () => {
    const tracker = new ThreadStatusTracker()
    tracker.recordUpdate('thread-1', 'content', 1000)
    expect(
      tracker.shouldUpdate(
        'thread-2',
        'content',
        1000,
        THREAD_STATUS_MIN_INTERVAL_MS
      )
    ).toBe(true)
  })
})
