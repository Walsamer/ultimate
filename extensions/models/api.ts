/**
 * Models: the model and thinking pickers and provider logins in the composer, and the `models.definition` point
 * through which a conversation whose model lost its login finds the model and family its agent definition runs on.
 * Core tier.
 */
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
export { LoginChanged } from './refs.ts'
/** What a conversation's agent definition runs on, as discovery resolved it (lib/families.ts `definitionRuns`). */
export type DefinitionRun = {
  /** The family it names, whose `fallback` applies to its conversations; undefined when it pins a model. */
  family?: string
  /** The model it runs on: its own pin, else its family's; undefined for the default family, the parent's model. */
  model?: { provider: string; modelId: string }
}
export type DefinitionService = {
  /** What the definition conversation `id` runs as runs on, read inside `tx`; undefined without a definition. */
  runs(tx: Tx, id: ConversationId): Promise<DefinitionRun | undefined>
}
/**
 * The extension point a conversation whose model lost its login or ran out of quota asks what its agent definition
 * runs on: the model it pins, which comes before the families' fallbacks, and its family, whose `fallback` comes
 * before the configured default. Subagents provides it (it records which definition a conversation runs as).
 */
export const Definition = defineApi<DefinitionService>()('models.definition')
export const tier = 'core'
