import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { configSchema, type Config } from './schema.js'

/**
 * Loads and validates the discord-agent-pilot config file at `path`.
 * Throws if the file cannot be read or fails schema validation.
 */
export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8')

  const parsed: unknown = parse(raw)
  return configSchema.parse(parsed)
}
