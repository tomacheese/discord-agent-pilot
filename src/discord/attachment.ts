/**
 * discord.js の `AttachmentBuilder`/`send` に渡す `attachment` フィールドへ変換する。
 *
 * discord.js は非 URL の文字列を「ファイルシステムパス」として解釈し、
 * `fs.stat` できなければ `FileNotFound` を投げる。`PostItem` の
 * `diff-file` の `data` は diff テキストそのもの(パスではない)なので、
 * 文字列の場合は必ず `Buffer` へ変換してから渡す必要がある。
 * @param data - 添付するファイルの内容(文字列または Buffer)
 * @returns discord.js の `attachment` に渡せる Buffer
 */
export function toAttachmentData(data: string | Buffer): Buffer {
  return typeof data === 'string' ? Buffer.from(data) : data
}
