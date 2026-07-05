import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js'
import type { Config } from '../config/schema.js'
import { isAllowedUser } from '../discord/permissions.js'

/** How long to wait for a human to resolve an ambiguous sessionId prompt before giving up (§4 step 5). */
const AMBIGUITY_PROMPT_TIMEOUT_MS = 5 * 60 * 1000

/** Tracks tmux-detected sessions still waiting on ambiguity resolution (§4 step 5). */
export class AmbiguityTracker {
  private readonly pending = new Map<string, string[]>()

  /** Builds the internal map key identifying a tmux session/pane pair. */
  private key(tmuxSession: string, panePid: string): string {
    return `${tmuxSession}:${panePid}`
  }

  /** Records that `tmuxSession`/`panePid` has ambiguous sessionId candidates awaiting human selection. */
  markPending(
    tmuxSession: string,
    panePid: string,
    candidates: string[]
  ): void {
    this.pending.set(this.key(tmuxSession, panePid), candidates)
  }

  /** Returns true if `tmuxSession`/`panePid` is currently awaiting ambiguity resolution. */
  isPending(tmuxSession: string, panePid: string): boolean {
    return this.pending.has(this.key(tmuxSession, panePid))
  }

  /** Clears the pending state for `tmuxSession`/`panePid` once resolved. */
  resolve(tmuxSession: string, panePid: string): void {
    this.pending.delete(this.key(tmuxSession, panePid))
  }
}

/** A select-menu interaction, minimally typed for what `promptSessionIdSelection` needs. */
interface SelectInteraction {
  user: { id: string }
  values: string[]
  reply: (options: { content: string; ephemeral: boolean }) => Promise<void>
}

/**
 * A collector of select-menu interactions on a posted message. The `end`
 * callback's parameter order (`collected` first, `reason` second) mirrors
 * discord.js's real `Collector` event signature, so a caller relying on
 * this interface receives the timeout reason in the correct position.
 */
interface ComponentCollector {
  on(
    event: 'collect',
    callback: (interaction: SelectInteraction) => void | Promise<void>
  ): void
  on(event: 'end', callback: (collected: unknown, reason: string) => void): void
  /** Stops the collector early, triggering its `end` event with the given reason. */
  stop(reason?: string): void
}

/** A posted Discord message capable of collecting component interactions. */
interface PromptMessage {
  createMessageComponentCollector(options: {
    time?: number
  }): ComponentCollector
}

/** The minimal channel interface `promptSessionIdSelection` needs to post a Select menu. */
export interface PromptChannel {
  send(options: unknown): Promise<PromptMessage>
}

/**
 * Posts a Select menu to `channel` listing `candidates` as sessionId
 * options, and resolves with the sessionId the first *allowed* user
 * selects (§4 step 5). Selections from non-allowed users are rejected with
 * an ephemeral reply and do not resolve the promise. If no allowed user
 * selects a candidate within `AMBIGUITY_PROMPT_TIMEOUT_MS`, resolves with
 * `undefined` instead of hanging indefinitely.
 */
export async function promptSessionIdSelection(
  channel: PromptChannel,
  candidates: string[],
  config: Config
): Promise<string | undefined> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('session-id-selection')
    .setPlaceholder('Select the matching Claude Code session')
    .addOptions(candidates.map((id) => ({ label: id, value: id })))
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    menu
  )

  const message = await channel.send({
    content:
      'Multiple Claude Code sessions matched this tmux pane. Please select the correct one:',
    components: [row],
  })

  return new Promise((resolve) => {
    // Guards against `resolve` being called twice: `end` still fires (with
    // reason 'user' rather than 'time') after `collector.stop()` below, and
    // without this guard that second call would try to resolve an
    // already-settled promise (a silent no-op, but relying on that is
    // fragile and obscures the intended single-resolution contract).
    let hasSettled = false
    const collector = message.createMessageComponentCollector({
      time: AMBIGUITY_PROMPT_TIMEOUT_MS,
    })
    collector.on('collect', async (interaction) => {
      if (!isAllowedUser(interaction.user.id, config)) {
        try {
          await interaction.reply({
            content: 'You are not allowed to perform this action.',
            ephemeral: true,
          })
        } catch {
          // Ignore reply failures (e.g. interaction already acknowledged);
          // the disallowed user simply isn't notified.
        }
        return
      }
      hasSettled = true
      // Stop the collector immediately so it doesn't keep listening for
      // (and dispatching to allowed/disallowed-user checks against) further
      // interactions on this message until the timeout elapses.
      collector.stop('user')
      resolve(interaction.values[0])
    })
    collector.on('end', (_collected, reason) => {
      if (hasSettled || reason !== 'time') return
      hasSettled = true
      resolve(undefined)
    })
  })
}
