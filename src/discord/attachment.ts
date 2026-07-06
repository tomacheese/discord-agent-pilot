/**
 * Converts file content to the `attachment` field passed to discord.js's
 * `AttachmentBuilder`/`send`.
 *
 * discord.js interprets a non-URL string as a filesystem path and throws
 * `FileNotFound` if `fs.stat` can't find it. A `diff-file` `PostItem`'s
 * `data` is the diff text itself (not a path), so string input must always
 * be converted to a `Buffer` before being passed through.
 * @param data - The attachment content (string or Buffer)
 * @returns A Buffer suitable for discord.js's `attachment` field
 */
export function toAttachmentData(data: string | Buffer): Buffer {
  return typeof data === 'string' ? Buffer.from(data) : data
}
