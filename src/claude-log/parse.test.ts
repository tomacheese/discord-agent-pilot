import { describe, expect, it, vi } from 'vitest'
import { parseJsonlLine } from './parse'

describe('parseJsonlLine', () => {
  it('parses an assistant entry with thinking, text, and tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'let me check the file' },
          { type: 'text', text: 'Here is the result.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'ls -la', description: 'list files' },
          },
        ],
      },
    })
    expect(parseJsonlLine(line)).toEqual({
      kind: 'assistant',
      content: [
        { type: 'thinking' },
        { type: 'text', text: 'Here is the result.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'ls -la', description: 'list files' },
        },
      ],
    })
  })

  it('parses a user entry with a normal tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 0' },
        ],
      },
    })
    expect(parseJsonlLine(line)).toEqual({
      kind: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 0' },
      ],
    })
  })

  it('parses a user entry with an is_error tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'command not found',
            is_error: true,
          },
        ],
      },
    })
    expect(parseJsonlLine(line)).toEqual({
      kind: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: 'command not found',
          is_error: true,
        },
      ],
    })
  })

  it('normalizes an array-form tool_result content into a joined string', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_3',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    })
    expect(parseJsonlLine(line)).toEqual({
      kind: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_3',
          content: 'line oneline two',
        },
      ],
    })
  })

  it('parses a user entry with a plain text block (echo/direct input)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'continue please' }] },
    })
    expect(parseJsonlLine(line)).toEqual({
      kind: 'user',
      content: [{ type: 'text', text: 'continue please' }],
    })
  })

  it('returns ignored for unknown top-level types', () => {
    const line = JSON.stringify({ type: 'system', content: 'noop' })
    expect(parseJsonlLine(line)).toEqual({ kind: 'ignored' })
  })

  it('returns undefined and warns on invalid JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(parseJsonlLine('{not valid json')).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
