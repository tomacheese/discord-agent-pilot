import { z } from 'zod'

/**
 * A single entry mapping a host-side CLAUDE_CONFIG_DIR path to its
 * container-side bind-mounted path (§6).
 */
const configDirectorySchema = z.object({
  hostPath: z.string().min(1),
  containerPath: z.string().min(1),
})

/**
 * The single Discord channel this deployment creates per-session threads
 * under (§6/§7).
 */
const parentChannelSchema = z.object({
  type: z.enum(['forum', 'text']),
  id: z.string().min(1),
})

/** Zod schema for the full discord-agent-pilot `config.yaml` file (§6). */
export const configSchema = z.object({
  guildId: z.string().min(1),
  parentChannel: parentChannelSchema,
  allowedUserIds: z.array(z.string().min(1)).min(1),
  workspaceRoots: z.array(z.string().min(1)).min(1),
  configDirs: z.array(configDirectorySchema).default([]),
  tmux: z.object({
    pollIntervalMs: z.number().int().positive().default(3000),
    socketDir: z.string().min(1),
  }),
  sessionResolution: z.object({
    ambiguityThresholdMs: z.number().int().positive().default(3000),
  }),
  claude: z.object({
    defaultConfigDir: configDirectorySchema,
    procRoot: z.string().min(1).default('/proc'),
  }),
})

/** Parsed and validated discord-agent-pilot configuration. */
export type Config = z.infer<typeof configSchema>
