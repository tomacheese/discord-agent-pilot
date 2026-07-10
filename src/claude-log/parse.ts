import { parseJsonl, type ParsedLine } from 'claude-code-jsonl-parser'

/**
 * Parses a single line of JSONL. The library's `parseJsonl` function expects
 * newline-delimited content, so this is a thin wrapper that accepts a line
 * without newlines and returns the first element of the result array. Empty
 * lines (whitespace-only after trimming) produce no result from `parseJsonl`,
 * so this returns `undefined` in those cases.
 *
 * Note: `parseJsonl` always returns Ok for Result<ParsedLine[], never>, but
 * ErrResult<never> does not have a `value` property, so direct access to
 * `.value` would require type narrowing. We use `.unwrapOr([])` instead since
 * it exists on both Ok and Err types, providing a safe unified interface.
 * @param line - A single line of string without newlines
 * @returns The parsed result, or `undefined` if the line is empty
 */
export function parseJsonlLine(line: string): ParsedLine | undefined {
  const lines: ParsedLine[] = parseJsonl(line).unwrapOr([])
  return lines[0]
}
