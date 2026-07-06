import eslintConfig from '@book000/eslint-config'

export default [
  ...eslintConfig,
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', 'data/'],
  },
  {
    rules: {
      // `db` is the conventional short name for a SQLite database handle
      // (better-sqlite3's own type is `Database.Database`); disable only
      // this one default replacement instead of the whole rule so other
      // discouraged abbreviations (e.g. `err`, `cb`) are still caught.
      'unicorn/name-replacements': ['error', { replacements: { db: false } }],
    },
  },
]
