import type { Config } from '../config/schema'

/** Returns true if `userId` is present in `config.allowedUserIds`. */
export function isAllowedUser(userId: string, config: Config): boolean {
  return config.allowedUserIds.includes(userId)
}
