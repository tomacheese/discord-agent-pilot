import type {
  AssistantContentBlock,
  ToolResultContentBlock,
  UserContentBlock,
  UserMessage,
} from 'claude-code-jsonl-parser'

/** A single unit of Discord output derived from one or more JSONL content blocks. */
export type PostItem =
  | { kind: 'typing' } // a thinking block: send a typing indicator, no message
  | { kind: 'messages'; texts: string[] } // pre-split plain-text messages (at most `MAX_TEXT_MESSAGES`)

const MAX_MESSAGE_LENGTH = 2000
const MAX_TEXT_MESSAGES = 5
const TRUNCATION_NOTICE = '\n...(以下省略、全文は JSONL 参照)'
const GENERIC_VALUE_MAX_LENGTH = 100

/**
 * Splits `text` into at most `MAX_TEXT_MESSAGES` chunks of at most
 * `MAX_MESSAGE_LENGTH` characters each. If the text does not fit in the
 * allotted messages, the last chunk is truncated and a notice is appended
 * (still within `MAX_MESSAGE_LENGTH`).
 */
function splitTextIntoMessages(text: string): string[] {
  if (text.length === 0) return []
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0 && chunks.length < MAX_TEXT_MESSAGES) {
    const isLastAllowedChunk = chunks.length === MAX_TEXT_MESSAGES - 1
    if (isLastAllowedChunk && remaining.length > MAX_MESSAGE_LENGTH) {
      const limit = MAX_MESSAGE_LENGTH - TRUNCATION_NOTICE.length
      chunks.push(remaining.slice(0, limit) + TRUNCATION_NOTICE)
      remaining = ''
    } else {
      chunks.push(remaining.slice(0, MAX_MESSAGE_LENGTH))
      remaining = remaining.slice(MAX_MESSAGE_LENGTH)
    }
  }
  return chunks
}

/**
 * Truncates `text` to fit `text + suffix` within `MAX_MESSAGE_LENGTH`,
 * appending `TRUNCATION_NOTICE` before `suffix` when it doesn't already fit.
 * `suffix` (e.g. an Edit/Write added/removed line count) is always kept
 * intact rather than being cut off along with `text`.
 */
function truncateToMessageLimit(text: string, suffix = ''): string {
  const full = text + suffix
  if (full.length <= MAX_MESSAGE_LENGTH) return full
  const limit = MAX_MESSAGE_LENGTH - TRUNCATION_NOTICE.length - suffix.length
  return text.slice(0, Math.max(limit, 0)) + TRUNCATION_NOTICE + suffix
}

/** Builds a `messages` PostItem from `text`, or returns an empty array for empty text. */
function textToItems(text: string): PostItem[] {
  const texts = splitTextIntoMessages(text)
  return texts.length > 0 ? [{ kind: 'messages', texts }] : []
}

/**
 * Counts the lines in `text` by scanning for newline characters, matching
 * `text.split('\n').length` (empty string counts as 1 line) without
 * allocating an array of substrings — large tool outputs can otherwise
 * trigger an avoidable memory/time spike.
 */
function countLines(text: string): number {
  let count = 1
  for (let index = 0; index < text.length; index++) {
    if (text.codePointAt(index) === 10) count++
  }
  return count
}

/**
 * Builds the `(結果: N行, M文字)` summary text that replaces a tool_result's
 * full content in the Discord post — showing size only, not the content
 * itself.
 */
function buildResultSummary(content: string): string {
  return `(結果: ${countLines(content)}行, ${content.length}文字)`
}

/** Builds the `key=value, ...` fallback summary used for tools with no dedicated format. */
function buildGenericSummary(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([key, value]) => {
      const stringValue =
        typeof value === 'string' ? value : JSON.stringify(value)
      const truncated =
        stringValue.length > GENERIC_VALUE_MAX_LENGTH
          ? `${stringValue.slice(0, GENERIC_VALUE_MAX_LENGTH)}...`
          : stringValue
      return `${key}=${truncated}`
    })
    .join(', ')
}

/** Builds the `<summary>` portion of `⏺ <ToolName>(<summary>)` for a given tool. */
function buildToolSummary(
  name: string,
  input: Record<string, unknown>
): string {
  switch (name) {
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : ''
      const description =
        typeof input.description === 'string' ? ` (${input.description})` : ''
      return `\`${command}\`${description}`
    }
    case 'Read': {
      const filePath =
        typeof input.file_path === 'string' ? input.file_path : ''
      const parts: string[] = []
      if (typeof input.offset === 'number') parts.push(`offset=${input.offset}`)
      if (typeof input.limit === 'number') parts.push(`limit=${input.limit}`)
      return parts.length > 0 ? `${filePath} (${parts.join(', ')})` : filePath
    }
    case 'Write':
    case 'Edit': {
      return typeof input.file_path === 'string' ? input.file_path : ''
    }
    case 'Grep':
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      const pathSuffix =
        typeof input.path === 'string' ? `, path=${input.path}` : ''
      return `pattern=${pattern}${pathSuffix}`
    }
    default: {
      return buildGenericSummary(input)
    }
  }
}

/**
 * Counts the lines in `text` for diff purposes, treating an empty string as
 * zero lines. This keeps a full-add or full-delete `Edit` symmetric
 * (`+0`/`-0` on the empty side) instead of reporting a phantom `+1`/`-1`
 * from `countLines('')`, which (matching `''.split('\n')`) returns 1.
 */
function countDiffLines(text: string): number {
  return text.length > 0 ? countLines(text) : 0
}

/** Treats `type: 'tool_use'`'s `input` (`unknown` in the library) as a plain object if it is one, or an empty object otherwise. */
function asInputRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

/** Formats a single `tool_use` block into a header-line PostItem, appending an added/removed line count for Edit/Write. */
function formatToolUse(block: { name: string; input: unknown }): PostItem[] {
  const input = asInputRecord(block.input)
  const summary = `⏺ ${block.name}(${buildToolSummary(block.name, input)})`
  if (block.name === 'Edit') {
    const oldString =
      typeof input.old_string === 'string' ? input.old_string : ''
    const newString =
      typeof input.new_string === 'string' ? input.new_string : ''
    const added = countDiffLines(newString)
    const removed = countDiffLines(oldString)
    return [
      {
        kind: 'messages',
        texts: [truncateToMessageLimit(summary, ` (+${added} -${removed})`)],
      },
    ]
  }
  if (block.name === 'Write') {
    const content = typeof input.content === 'string' ? input.content : ''
    const added = countDiffLines(content)
    return [
      {
        kind: 'messages',
        texts: [truncateToMessageLimit(summary, ` (+${added})`)],
      },
    ]
  }
  return [{ kind: 'messages', texts: [truncateToMessageLimit(summary)] }]
}

/** Formats a single known assistant content block into zero or more PostItems. */
function formatAssistantBlock(
  block: Extract<AssistantContentBlock, { _kind: 'known' }>
): PostItem[] {
  switch (block.type) {
    case 'thinking': {
      return [{ kind: 'typing' }]
    }
    case 'text': {
      return textToItems(block.text)
    }
    case 'tool_use': {
      return formatToolUse(block)
    }
    default: {
      // A known block type that is neither thinking/text/tool_use (added by
      // the library in the future) is intentionally ignored, same as an
      // unknown block — this avoids silently misrendering a future block
      // type as a tool_use summary.
      return []
    }
  }
}

/** Converts an assistant entry's content blocks into Discord PostItems, in order. */
export function formatAssistantEntry(
  content: AssistantContentBlock[]
): PostItem[] {
  const items: PostItem[] = []
  for (const block of content) {
    if (block._kind === 'unknown') continue
    items.push(...formatAssistantBlock(block))
  }
  return items
}

/** Normalizes `tool_result`'s `content` (string or array) into a string made by concatenating only `text` blocks. `image`/`tool_reference`/`unknown` blocks are ignored (matching the existing behavior). */
function extractToolResultText(
  content: string | ToolResultContentBlock[]
): string {
  if (typeof content === 'string') return content
  return content
    .map((block) =>
      block._kind !== 'unknown' && block.type === 'text' ? block.text : ''
    )
    .join('')
}

/**
 * Converts a user entry's content blocks into Discord PostItems, in order.
 * `isEcho` determines whether a plain-text block matches an unconsumed
 * Discord-originated `input_queue` entry and should therefore be skipped
 * (it is already visible in Discord as the original message).
 */
export function formatUserEntry(
  content: UserMessage['content'],
  isEcho: (text: string) => boolean
): PostItem[] {
  const blocks: UserContentBlock[] =
    typeof content === 'string'
      ? [{ _kind: 'known', type: 'text', text: content }]
      : content
  const items: PostItem[] = []
  for (const block of blocks) {
    if (block._kind === 'unknown') continue
    if (block.type === 'tool_result') {
      const text = extractToolResultText(block.content)
      if (block.is_error === true) {
        items.push({
          kind: 'messages',
          texts: [`⚠️ Error ${buildResultSummary(text)}`],
        })
      } else if (text.length > 0) {
        items.push({ kind: 'messages', texts: [buildResultSummary(text)] })
      }
    } else if (!isEcho(block.text)) {
      items.push(...textToItems(block.text))
    }
  }
  return items
}
