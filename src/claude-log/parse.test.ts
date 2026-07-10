import { describe, expect, it } from 'vitest'
import { parseJsonlLine } from './parse'

describe('parseJsonlLine', () => {
  it('parses a single JSONL line by delegating to the library', () => {
    const line = JSON.stringify({
      type: 'mode',
      mode: 'default',
      sessionId: 'session-1',
    })
    expect(parseJsonlLine(line)).toEqual({
      _kind: 'known',
      type: 'mode',
      mode: 'default',
      sessionId: 'session-1',
    })
  })

  it('returns undefined for an empty line', () => {
    expect(parseJsonlLine('')).toBeUndefined()
  })

  it('returns undefined for a whitespace-only line', () => {
    expect(parseJsonlLine('   ')).toBeUndefined()
  })

  it('returns a LineParseError for invalid JSON', () => {
    const result = parseJsonlLine('{not valid json')
    expect(result?._kind).toBe('error')
  })

  it('returns an UnknownEntry for an unrecognized top-level type', () => {
    const result = parseJsonlLine(
      JSON.stringify({ type: 'totally-unknown-type' })
    )
    expect(result?._kind).toBe('unknown')
  })
})
