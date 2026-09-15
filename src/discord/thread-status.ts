import type { PostItem } from '../claude-log/format'

const ACTION_SUMMARY_MAX_LENGTH = 100
const STATUS_CONTENT_MAX_LENGTH = 300
// Discord's own hard limit on a message's content length; the final safety
// truncation must never exceed this regardless of STATUS_CONTENT_MAX_LENGTH.
const DISCORD_MESSAGE_MAX_LENGTH = 2000
const NO_ACTION_YET_TEXT = '(まだアクションなし)'

/** Input to `formatThreadStatus`: the pieces of a session's current status. */
export interface ThreadStatusInput {
  title: string
  isRunning: boolean
  lastActionSummary: string
  elapsedMinutes: number
}

/**
 * Extracts a short summary of the most recent action from one JSONL line's
 * already-formatted `PostItem`s, for display in the thread starter message.
 * Returns `undefined` when the line carries no displayable summary (empty,
 * or thinking-only), so the caller knows to leave the previously stored
 * summary untouched rather than overwrite it with something less useful.
 */
export function summarizePostItems(items: PostItem[]): string | undefined {
  const lastMessageItem = items.findLast(
    (item): item is Extract<PostItem, { kind: 'messages' }> =>
      item.kind === 'messages' && item.texts.length > 0
  )
  const text = lastMessageItem?.texts.at(-1)
  if (!text) return undefined
  return text.length > ACTION_SUMMARY_MAX_LENGTH
    ? text.slice(0, ACTION_SUMMARY_MAX_LENGTH) + '…'
    : text
}

/**
 * Builds the thread starter message content reflecting a session's current
 * status (running/stopped, most recent action, elapsed time). Pure
 * formatting only — does not touch Discord.
 */
export function formatThreadStatus(input: ThreadStatusInput): string {
  const stateLabel = input.isRunning ? '実行中' : '停止中'
  const action =
    input.lastActionSummary.length > 0
      ? input.lastActionSummary
      : NO_ACTION_YET_TEXT
  const content = `Session thread: ${input.title}\n状態: ${stateLabel} (経過 ${input.elapsedMinutes}分)\n直近: ${action}`
  const truncated =
    content.length > STATUS_CONTENT_MAX_LENGTH
      ? content.slice(0, STATUS_CONTENT_MAX_LENGTH) + '…'
      : content
  // Final safety net: STATUS_CONTENT_MAX_LENGTH is always far below
  // Discord's hard limit, but never send more than Discord accepts.
  return truncated.length > DISCORD_MESSAGE_MAX_LENGTH
    ? truncated.slice(0, DISCORD_MESSAGE_MAX_LENGTH)
    : truncated
}
