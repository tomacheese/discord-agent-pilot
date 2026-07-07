/**
 * Converts file content to the `attachment` field passed to discord.js's
 * `AttachmentBuilder`/`send`.
 *
 * discord.js interprets a non-URL string as a filesystem path and throws
 * `FileNotFound` if `fs.stat` can't find it. File attachment content is
 * often produced as a string (not a path), so string input must always be
 * converted to a `Buffer` before being passed through.
 * @param data - The attachment content (string or Buffer)
 * @returns A Buffer suitable for discord.js's `attachment` field
 */
export function toAttachmentData(data: string | Buffer): Buffer {
  return typeof data === 'string' ? Buffer.from(data) : data
}
