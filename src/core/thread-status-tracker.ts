/** Minimum interval between two starter-message edits for the same thread, to stay well within Discord's message-edit rate limit. */
export const THREAD_STATUS_MIN_INTERVAL_MS = 10_000

/**
 * Tracks, per thread, the starter message content last applied and when,
 * so the caller only re-edits a thread's starter message when its content
 * has actually changed and enough time has passed since the last edit.
 */
export class ThreadStatusTracker {
  private readonly applied = new Map<
    string,
    { content: string; lastEditedAt: number }
  >()

  /**
   * Returns true if `threadId`'s starter message should be re-edited with
   * `content` at time `now`: no edit has been recorded yet, or `content`
   * differs from what was last applied and at least `minIntervalMs` has
   * elapsed since the last edit.
   */
  shouldUpdate(
    threadId: string,
    content: string,
    now: number,
    minIntervalMs: number
  ): boolean {
    const last = this.applied.get(threadId)
    if (!last) return true
    if (last.content === content) return false
    return now - last.lastEditedAt >= minIntervalMs
  }

  /** Records that `content` was just applied to `threadId` at time `now`. */
  recordUpdate(threadId: string, content: string, now: number): void {
    this.applied.set(threadId, { content, lastEditedAt: now })
  }
}
