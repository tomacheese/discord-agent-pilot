import { describe, expect, it } from 'vitest'
import { formatAssistantEntry, formatUserEntry } from './format'

describe('formatAssistantEntry', () => {
  it('converts a thinking block into a typing item', () => {
    expect(formatAssistantEntry([{ type: 'thinking' }])).toEqual([
      { kind: 'typing' },
    ])
  })

  it('converts a short text block into a single-message item', () => {
    expect(
      formatAssistantEntry([{ type: 'text', text: 'Hello there' }])
    ).toEqual([{ kind: 'messages', texts: ['Hello there'] }])
  })

  it('splits a text block longer than 2000 characters into multiple messages', () => {
    const text = 'a'.repeat(4500)
    const result = formatAssistantEntry([{ type: 'text', text }])
    expect(result).toHaveLength(1)
    const item = result[0]
    if (item.kind !== 'messages') throw new Error('expected messages item')
    expect(item.texts).toHaveLength(3)
    expect(item.texts[0]).toHaveLength(2000)
    expect(item.texts[1]).toHaveLength(2000)
    expect(item.texts[2]).toHaveLength(500)
  })

  it('caps text at 5 messages and appends a truncation notice to the last one', () => {
    const text = 'a'.repeat(2000 * 6)
    const result = formatAssistantEntry([{ type: 'text', text }])
    const item = result[0]
    if (item.kind !== 'messages') throw new Error('expected messages item')
    expect(item.texts).toHaveLength(5)
    expect(item.texts[4].endsWith('...(以下省略、全文は JSONL 参照)')).toBe(
      true
    )
    expect(item.texts[4].length).toBeLessThanOrEqual(2000)
  })

  it('formats a Bash tool_use with command and description', () => {
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls -la', description: 'list files' },
      },
    ])
    expect(result).toEqual([
      { kind: 'messages', texts: ['⏺ Bash(`ls -la` (list files))'] },
    ])
  })

  it('formats a Read tool_use with offset/limit', () => {
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'Read',
        input: { file_path: '/tmp/foo.txt', offset: 100, limit: 50 },
      },
    ])
    expect(result).toEqual([
      {
        kind: 'messages',
        texts: ['⏺ Read(/tmp/foo.txt (offset=100, limit=50))'],
      },
    ])
  })

  it('formats a Grep tool_use with pattern and path', () => {
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_3',
        name: 'Grep',
        input: { pattern: 'TODO', path: 'src' },
      },
    ])
    expect(result).toEqual([
      { kind: 'messages', texts: ['⏺ Grep(pattern=TODO, path=src)'] },
    ])
  })

  it('falls back to a generic key=value summary for unknown tools', () => {
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_4',
        name: 'WebSearch',
        input: { query: 'weather today' },
      },
    ])
    expect(result).toEqual([
      { kind: 'messages', texts: ['⏺ WebSearch(query=weather today)'] },
    ])
  })

  it('truncates long generic values to 100 characters', () => {
    const longValue = 'x'.repeat(150)
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_5',
        name: 'UnknownTool',
        input: { note: longValue },
      },
    ])
    const item = result[0]
    if (item.kind !== 'messages') throw new Error('expected messages item')
    expect(item.texts[0]).toBe(`⏺ UnknownTool(note=${'x'.repeat(100)}...)`)
  })

  it('truncates an overly long Bash command summary to fit within the Discord message limit', () => {
    const longCommand = 'echo ' + 'a'.repeat(3000)
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_10',
        name: 'Bash',
        input: { command: longCommand },
      },
    ])
    const item = result[0]
    if (item.kind !== 'messages') throw new Error('expected messages item')
    expect(item.texts).toHaveLength(1)
    expect(item.texts[0].length).toBeLessThanOrEqual(2000)
    expect(item.texts[0].endsWith('...(以下省略、全文は JSONL 参照)')).toBe(
      true
    )
  })

  it('truncates a long Edit summary while keeping the added/removed suffix intact', () => {
    const longPath = '/tmp/' + 'a'.repeat(3000) + '.ts'
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_11',
        name: 'Edit',
        input: {
          file_path: longPath,
          old_string: 'const a = 1',
          new_string: 'const a = 2',
        },
      },
    ])
    const item = result[0]
    if (item.kind !== 'messages') throw new Error('expected messages item')
    expect(item.texts).toHaveLength(1)
    expect(item.texts[0].length).toBeLessThanOrEqual(2000)
    // The added/removed suffix must survive truncation, not be cut off
    // along with the (already-truncated) summary portion.
    expect(
      item.texts[0].endsWith('...(以下省略、全文は JSONL 参照) (+1 -1)')
    ).toBe(true)
  })

  it('formats an Edit tool_use as a single header line with added/removed line counts', () => {
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_6',
        name: 'Edit',
        input: {
          file_path: '/tmp/foo.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 2',
        },
      },
    ])
    expect(result).toEqual([
      { kind: 'messages', texts: ['⏺ Edit(/tmp/foo.ts) (+1 -1)'] },
    ])
  })

  it('formats a Write tool_use as a single header line with an added line count', () => {
    const result = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_7',
        name: 'Write',
        input: { file_path: '/tmp/new.ts', content: 'line1\nline2' },
      },
    ])
    expect(result).toEqual([
      { kind: 'messages', texts: ['⏺ Write(/tmp/new.ts) (+2)'] },
    ])
  })

  it('reports +0/-0 for an Edit that fully deletes or fully adds content', () => {
    const fullDelete = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_8',
        name: 'Edit',
        input: {
          file_path: '/tmp/foo.ts',
          old_string: 'line1\nline2',
          new_string: '',
        },
      },
    ])
    expect(fullDelete).toEqual([
      { kind: 'messages', texts: ['⏺ Edit(/tmp/foo.ts) (+0 -2)'] },
    ])

    const fullAdd = formatAssistantEntry([
      {
        type: 'tool_use',
        id: 'toolu_9',
        name: 'Edit',
        input: {
          file_path: '/tmp/foo.ts',
          old_string: '',
          new_string: 'line1\nline2',
        },
      },
    ])
    expect(fullAdd).toEqual([
      { kind: 'messages', texts: ['⏺ Edit(/tmp/foo.ts) (+2 -0)'] },
    ])
  })
})

describe('formatUserEntry', () => {
  it('summarizes a normal tool_result as a line/character count instead of its full content', () => {
    const result = formatUserEntry(
      [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 0' }],
      () => false
    )
    expect(result).toEqual([
      { kind: 'messages', texts: ['(結果: 1行, 7文字)'] },
    ])
  })

  it('omits a normal tool_result entirely when its content is empty', () => {
    const result = formatUserEntry(
      [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '' }],
      () => false
    )
    expect(result).toEqual([])
  })

  it('summarizes an is_error tool_result with a warning marker and a line/character count', () => {
    const result = formatUserEntry(
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: 'command not found',
          is_error: true,
        },
      ],
      () => false
    )
    expect(result).toEqual([
      { kind: 'messages', texts: ['⚠️ Error (結果: 1行, 17文字)'] },
    ])
  })

  it('still posts a summary for an is_error tool_result even when its content is empty', () => {
    const result = formatUserEntry(
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: '',
          is_error: true,
        },
      ],
      () => false
    )
    expect(result).toEqual([
      { kind: 'messages', texts: ['⚠️ Error (結果: 1行, 0文字)'] },
    ])
  })

  it('posts a text block that does not match input_queue', () => {
    const result = formatUserEntry(
      [{ type: 'text', text: 'typed directly in tmux' }],
      () => false
    )
    expect(result).toEqual([
      { kind: 'messages', texts: ['typed directly in tmux'] },
    ])
  })

  it('skips a text block that matches an unconsumed input_queue entry', () => {
    const result = formatUserEntry(
      [{ type: 'text', text: 'from discord' }],
      (text) => text === 'from discord'
    )
    expect(result).toEqual([])
  })
})
