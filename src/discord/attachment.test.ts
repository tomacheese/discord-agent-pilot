import { describe, expect, it } from 'vitest'
import { toAttachmentData } from './attachment'

describe('toAttachmentData', () => {
  it('converts a string into a Buffer instead of passing it through', () => {
    const result = toAttachmentData('diff --git a/foo b/foo\n+bar')
    expect(Buffer.isBuffer(result)).toBe(true)
    expect(result.toString('utf8')).toBe('diff --git a/foo b/foo\n+bar')
  })

  it('passes a Buffer through unchanged', () => {
    const input = Buffer.from('binary content')
    const result = toAttachmentData(input)
    expect(result).toBe(input)
  })
})
