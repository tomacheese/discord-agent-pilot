import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
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
    .toSorted((a, b) => a.version - b.version)
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  for (const { file, version } of files) {
    if (version <= currentVersion) continue
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    db.exec(sql)
    db.pragma(`user_version = ${version}`)
  }
}

/**
 * Opens (creating if necessary) the session registry SQLite database at
 * `dbPath` and applies any pending migrations from `migrations/`.
 */
export function openRegistryDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // SQLite disables foreign key enforcement by default even when a table
  // declares a REFERENCES constraint; without this, orphan
  // input_queue.session_id values would be silently allowed.
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}
