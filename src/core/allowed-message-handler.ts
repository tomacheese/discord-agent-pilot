import type Database from 'better-sqlite3'
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
 */
export function handleAllowedMessage(
  db: Database.Database,
  inputDeliveryDependencies: InputDeliveryDependencies,
  threadId: string,
  content: string
): void {
  const session = findSessionByThreadId(db, threadId)
  if (!session || session.status === 'closed') return
  if (content.trim() === '') return

  const inputQueueId = insertPendingInput(db, session.id, 'discord', content)
  console.info(
    `Queued input_queue row ${inputQueueId} for session ${session.id}`
  )
  triggerInputDelivery(inputDeliveryDependencies, session.id)
}
