/** A single top-level JSONL entry after parsing and type-narrowing. */
export type ParsedEntry =
  | { kind: 'assistant'; content: AssistantContentBlock[] }
  | { kind: 'user'; content: UserContentBlock[] }
  | { kind: 'ignored' } // any top-level type other than assistant/user

/** A content block found inside an `assistant` entry's `message.content[]`. */
export type AssistantContentBlock =
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }

/** A content block found inside a `user` entry's `message.content[]`. */
export type UserContentBlock =
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }
  | { type: 'text'; text: string }

interface RawContentBlock {
  type?: unknown
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

/** Extracts `message.content[]` from a raw parsed JSON value, defaulting to an empty array. */
function getContentBlocks(raw: unknown): RawContentBlock[] {
  if (typeof raw !== 'object' || raw === null) return []
  const message = (raw as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as { content?: unknown }).content
  return Array.isArray(content) ? (content as RawContentBlock[]) : []
}

/**
 * Normalizes a `tool_result` block's `content` field, which Claude Code
 * emits either as a plain string or as an array of text content blocks.
 */
function extractToolResultContent(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : ''
      )
      .join('')
  }
  return ''
}

function parseAssistantContent(raw: unknown): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = []
  for (const block of getContentBlocks(raw)) {
    if (block.type === 'thinking') {
      blocks.push({ type: 'thinking' })
    } else if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    } else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      typeof block.input === 'object' &&
      block.input !== null
    ) {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      })
    }
  }
  return blocks
}

function parseUserContent(raw: unknown): UserContentBlock[] {
  const blocks: UserContentBlock[] = []
  for (const block of getContentBlocks(raw)) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: extractToolResultContent(block.content),
        ...(block.is_error === true && { is_error: true }),
      })
    } else if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    }
  }
  return blocks
}

/**
 * Parses a single JSONL line into a `ParsedEntry`. Returns `undefined` (and
 * logs a warning) if the line is not valid JSON — the caller is expected to
 * skip the line while still advancing past it.
 */
export function parseJsonlLine(line: string): ParsedEntry | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (error) {
    console.warn('Failed to parse JSONL line as JSON:', error)
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return { kind: 'ignored' }
  const type = (raw as { type?: unknown }).type
  if (type === 'assistant') {
    return { kind: 'assistant', content: parseAssistantContent(raw) }
  }
  if (type === 'user') {
    return { kind: 'user', content: parseUserContent(raw) }
  }
  return { kind: 'ignored' }
}
