/* eslint-disable unicorn/import-style,unicorn/name-replacements,unicorn/no-array-sort,unicorn/require-array-sort-compare */
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * Applies every `migrations/NNN_*.sql` file whose sequence number is
 * greater than the database's current `user_version`, in order.
 */
function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  for (const [index, file] of files.entries()) {
    const version = index + 1
    if (version <= currentVersion) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec(sql)
    db.pragma(`user_version = ${version}`)
  }
}

/**
 * Opens (creating if necessary) the session registry SQLite database at
 * `path` and applies any pending migrations from `migrations/`.
 */
export function openRegistryDb(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  applyMigrations(db)
  return db
}
/* eslint-enable unicorn/import-style,unicorn/name-replacements,unicorn/no-array-sort,unicorn/require-array-sort-compare */
