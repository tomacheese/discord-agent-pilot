import type { ForumChannel, TextChannel } from 'discord.js'
import { loadConfig } from './config/load'
import { openRegistryDb as openRegistryDatabase } from './registry/db'
import { createDiscordClient } from './discord/client'
import { createParentChannel } from './discord/parent-channel'
import { AmbiguityTracker } from './core/ambiguity'
import {
  runDetectionCycle,
  type OrchestratorDependencies,
} from './core/orchestrator'
import {
  runLogSyncCycle,
  type LogSyncDependencies,
  type SendInput,
} from './core/log-sync-worker'
import { resolveTmuxSocketPath } from './tmux/list-sessions'

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
    resolvedPanes: new Map(),
    registeringSessionIds: new Set(),
  }

  const LOG_SYNC_POLL_INTERVAL_MS = 1000

  const logSyncDependencies: LogSyncDependencies = {
    db: database,
    getThread: async (threadId) => {
      // eslint-disable-next-line unicorn/prefer-await
      const channel = await client.channels.fetch(threadId).catch(() => null)
      if (!channel || !('send' in channel) || !('sendTyping' in channel)) {
        return undefined
      }
      return {
        send: (input: SendInput) =>
          channel.send({
            content: input.content,
            files: input.files?.map((file) => ({
              attachment: file.data,
              name: file.name,
            })),
          }),
        sendTyping: () => channel.sendTyping(),
      }
    },
    pollIntervalMs: LOG_SYNC_POLL_INTERVAL_MS,
  }

  let isLogSyncCycleInProgress = false
  setInterval(() => {
    if (isLogSyncCycleInProgress) return
    isLogSyncCycleInProgress = true
    // eslint-disable-next-line no-void
    void runLogSyncCycle(logSyncDependencies)
      .catch((error: unknown) => {
        console.error('Log sync cycle failed:', error)
      })
      .finally(() => {
        isLogSyncCycleInProgress = false
      })
  }, LOG_SYNC_POLL_INTERVAL_MS)

  // Guards against overlapping cycles: if a cycle is still running when the
  // next tick fires (e.g. a slow Discord API call), the next tick is
  // skipped rather than started concurrently. Panes within a single cycle
  // are now processed in parallel (see runDetectionCycle), so
  // `registeringSessionIds` is the guard against duplicate Discord threads
  // for the same sessionId; this outer flag only prevents two separate
  // cycles from overlapping.
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
