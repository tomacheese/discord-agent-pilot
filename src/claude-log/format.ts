import path from 'node:path'
import type { AssistantContentBlock, UserContentBlock } from './parse'

/** A single unit of Discord output derived from one or more JSONL content blocks. */
export type PostItem =
  | { kind: 'typing' } // a thinking block: send a typing indicator, no message
  | { kind: 'messages'; texts: string[] } // pre-split plain-text messages (at most `MAX_TEXT_MESSAGES`)
  | { kind: 'diff-inline'; header: string; diffBlock: string } // rendered as a ```diff``` fenced block
  | { kind: 'diff-file'; header: string; filename: string; content: string } // posted as a file attachment

const MAX_MESSAGE_LENGTH = 2000
const MAX_TEXT_MESSAGES = 5
const TRUNCATION_NOTICE = '\n...(以下省略、全文は JSONL 参照)'
const DIFF_INLINE_LIMIT = 1900
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

/** Builds a `messages` PostItem from `text`, or returns an empty array for empty text. */
function textToItems(text: string): PostItem[] {
  const texts = splitTextIntoMessages(text)
  return texts.length > 0 ? [{ kind: 'messages', texts }] : []
}

/**
 * Builds the `(結果: N行, M文字)` summary text that replaces a tool_result's
 * full content in the Discord post — showing size only, not the content
 * itself.
 */
function buildResultSummary(content: string): string {
  const lineCount = content.split('\n').length
  return `(結果: ${lineCount}行, ${content.length}文字)`
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

/** Builds the `-`/`+` unified-style diff body (without the fenced code block wrapper). */
function buildDiffBlock(oldString: string, newString: string): string {
  const oldLines =
    oldString.length > 0 ? oldString.split('\n').map((line) => `-${line}`) : []
  const newLines = newString.split('\n').map((line) => `+${line}`)
  return [...oldLines, ...newLines].join('\n')
}

/** Wraps a diff body into a `diff-inline` or `diff-file` PostItem depending on its size. */
function buildDiffItem(
  header: string,
  toolName: string,
  input: Record<string, unknown>,
  diffBlock: string
): PostItem {
  if (diffBlock.length <= DIFF_INLINE_LIMIT) {
    return { kind: 'diff-inline', header, diffBlock }
  }
  const filePath =
    typeof input.file_path === 'string' ? input.file_path : 'file'
  const filename = `${toolName}-${path.basename(filePath)}.diff`
  return { kind: 'diff-file', header, filename, content: diffBlock }
}

/** Formats a single `tool_use` block into one or more PostItems (summary, plus a diff for tools that produce one). */
function formatToolUse(block: {
  name: string
  input: Record<string, unknown>
}): PostItem[] {
  const header = `⏺ ${block.name}(${buildToolSummary(block.name, block.input)})`
  const summaryItem: PostItem = { kind: 'messages', texts: [header] }
  if (block.name === 'Edit') {
    const oldString =
      typeof block.input.old_string === 'string' ? block.input.old_string : ''
    const newString =
      typeof block.input.new_string === 'string' ? block.input.new_string : ''
    return [
      summaryItem,
      buildDiffItem(
        header,
        block.name,
        block.input,
        buildDiffBlock(oldString, newString)
      ),
    ]
  }
  if (block.name === 'Write') {
    const content =
      typeof block.input.content === 'string' ? block.input.content : ''
    return [
      summaryItem,
      buildDiffItem(
        header,
        block.name,
        block.input,
        buildDiffBlock('', content)
      ),
    ]
  }
  return [summaryItem]
}

/** Converts an assistant entry's content blocks into Discord PostItems, in order. */
export function formatAssistantEntry(
  content: AssistantContentBlock[]
): PostItem[] {
  const items: PostItem[] = []
  for (const block of content) {
    if (block.type === 'thinking') {
      items.push({ kind: 'typing' })
    } else if (block.type === 'text') {
      items.push(...textToItems(block.text))
    } else {
      items.push(...formatToolUse(block))
    }
  }
  return items
}

/**
 * Converts a user entry's content blocks into Discord PostItems, in order.
 * `isEcho` determines whether a plain-text block matches an unconsumed
 * Discord-originated `input_queue` entry and should therefore be skipped
 * (it is already visible in Discord as the original message).
 */
export function formatUserEntry(
  content: UserContentBlock[],
  isEcho: (text: string) => boolean
): PostItem[] {
  const items: PostItem[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      if (block.is_error === true) {
        items.push({
          kind: 'messages',
          texts: [`⚠️ Error ${buildResultSummary(block.content)}`],
        })
      } else if (block.content.length > 0) {
        items.push({
          kind: 'messages',
          texts: [buildResultSummary(block.content)],
        })
      }
    } else if (!isEcho(block.text)) {
      items.push(...textToItems(block.text))
    }
  }
  return items
}
