import { parseJsonl, type ParsedLine } from 'claude-code-jsonl-parser'

/**
 * JSONL の 1 行をパースする。ライブラリの `parseJsonl` は改行区切りの全文を
 * 前提とするため、改行を含まない 1 行を渡して結果配列の先頭要素を返す薄い
 * ラッパー。空行(トリム後に空)は `parseJsonl` が結果を生成しないため
 * `undefined` を返す。
 * `parseJsonl` は常に `Result<ParsedLine[], never>` の Ok を返す仕様だが、
 * `ErrResult<never>` は `value` プロパティを持たない型のため直接
 * `.value` にはアクセスできない。`unwrapOr` は Ok/Err どちらの型にも
 * 存在するため、型を安全に絞り込む代わりにこちらを使う。
 * @param line - 改行を含まない 1 行分の文字列
 * @returns パース結果。空行の場合は `undefined`
 */
export function parseJsonlLine(line: string): ParsedLine | undefined {
  const lines: ParsedLine[] = parseJsonl(line).unwrapOr([])
  return lines[0]
}

export type { ParsedLine } from 'claude-code-jsonl-parser'
