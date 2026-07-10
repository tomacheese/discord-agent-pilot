import { findSessionByThreadId } from '../registry/sessions'
import { insertPendingInput } from '../registry/input-queue'
import {
  triggerInputDelivery,
  type InputDeliveryDependencies,
} from './input-delivery-worker'

/**
 * Handles one incoming Discord message from an allowed user in a session
 * thread: resolves the session for `threadId`, skips messages that should
 * not be queued (no matching session, a closed session, or
 * empty/whitespace-only text), otherwise queues the message body into
 * `input_queue` and triggers delivery.
 *
 * The empty/whitespace-only skip guards against attachment-only or
 * sticker-only posts, whose `content` is `''`: queuing those would make the
 * delivery worker submit a bare Enter keystroke to the live tmux pane.
 *
 * Uses `inputDeliveryDependencies.db` for both lookups and queuing rather
 * than taking a separate `db` parameter, so there is only one database
 * instance in play instead of two that could accidentally diverge.
 */
export function handleAllowedMessage(
  inputDeliveryDependencies: InputDeliveryDependencies,
  threadId: string,
  content: string
): void {
  const { db } = inputDeliveryDependencies
  const session = findSessionByThreadId(db, threadId)
  if (!session || session.status === 'closed') return
  if (content.trim() === '') return

  const inputQueueId = insertPendingInput(db, session.id, 'discord', content)
  console.info(
    `Queued input_queue row ${inputQueueId} for session ${session.id}`
  )
  triggerInputDelivery(inputDeliveryDependencies, session.id)
}
