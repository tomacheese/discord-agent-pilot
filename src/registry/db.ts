/* eslint-disable unicorn/import-style,unicorn/name-replacements,unicorn/no-array-sort */
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations'
)

/**
 * Extracts the numeric `NNN` prefix from a `migrations/NNN_*.sql` filename,
 * used as the migration's `user_version`. Deriving the version from the
 * filename (rather than its position in a sorted directory listing) keeps
 * `user_version` stable even if a migration file is inserted, removed, or
 * renamed later.
 */
function parseMigrationVersion(file: string): number {
  const match = /^(\d+)_/.exec(file)
  if (!match) {
    throw new Error(`Migration filename missing numeric prefix: ${file}`)
  }
  return Number(match[1])
}

/**
 * Applies every `migrations/NNN_*.sql` file whose numeric prefix is greater
 * than the database's current `user_version`, in order.
 */
function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => ({ file, version: parseMigrationVersion(file) }))
    .sort((a, b) => a.version - b.version)
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  for (const { file, version } of files) {
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
/* eslint-enable unicorn/import-style,unicorn/name-replacements,unicorn/no-array-sort */
