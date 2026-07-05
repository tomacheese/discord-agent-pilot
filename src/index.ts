import type { ForumChannel, TextChannel } from 'discord.js'
import { loadConfig } from './config/load.js'
import { openRegistryDb as openRegistryDatabase } from './registry/db.js'
import { createDiscordClient } from './discord/client.js'
import { createParentChannel } from './discord/parent-channel.js'
import { AmbiguityTracker } from './core/ambiguity.js'
import {
  runDetectionCycle,
  type OrchestratorDeps as OrchestratorDependencies,
} from './core/orchestrator.js'
import { resolveTmuxSocketPath } from './tmux/list-sessions.js'

const configPath = process.env.CONFIG_PATH ?? './config.yaml'
const config = loadConfig(configPath)
const database = openRegistryDatabase(
  process.env.DB_PATH ?? './data/registry.db'
)
const client = createDiscordClient(config)

/** Fetches the configured parent channel and starts the detection polling loop. */
async function main(): Promise<void> {
  const rawChannel = await client.channels.fetch(config.parentChannel.id)
  if (!rawChannel || !('threads' in rawChannel)) {
    throw new Error(
      `Parent channel not found or unsupported: ${config.parentChannel.id}`
    )
  }
  const parentChannel = createParentChannel(
    rawChannel as ForumChannel | TextChannel,
    config.parentChannel.type
  )
  const socketPath = resolveTmuxSocketPath(config.tmux.socketDir)

  const dependencies: OrchestratorDependencies = {
    db: database,
    parentChannel,
    // Only a text parent channel can host the ambiguity Select menu
    // (ForumChannel has no `.send()`); forum deployments run without
    // human-assisted ambiguity resolution in Phase 1 (Global Constraints).
    promptChannel:
      config.parentChannel.type === 'text'
        ? (rawChannel as TextChannel)
        : undefined,
    ambiguityTracker: new AmbiguityTracker(),
    procRoot: config.claude.procRoot,
    socketPath,
  }

  // Guards against overlapping cycles: if a cycle is still running when the
  // next tick fires (e.g. a slow Discord API call), the next tick is
  // skipped rather than started concurrently, which would otherwise let
  // two cycles both pass registerSession's existence check for the same
  // sessionId and race to create duplicate Discord threads.
  let isCycleInProgress = false
  setInterval(() => {
    if (isCycleInProgress) return
    isCycleInProgress = true
    // eslint-disable-next-line no-void
    void runDetectionCycle(dependencies, config)
      .catch((error: unknown) => {
        console.error('Detection cycle failed:', error)
      })
      .finally(() => {
        isCycleInProgress = false
      })
  }, config.tmux.pollIntervalMs)
}

client.once('ready', () => {
  // eslint-disable-next-line no-void
  void main().catch((error: unknown) => {
    console.error('Fatal error while starting the orchestrator:', error)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  })
})

// eslint-disable-next-line no-void
void client.login(process.env.DISCORD_TOKEN)
