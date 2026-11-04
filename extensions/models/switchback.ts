/**
 * The one family that switches back by itself. `review` runs on its subscription model; when that provider refuses for a
 * spent account the conversation moves to the fallback the family names (`fallback.ts`) and records the move in
 * `models.switchback`, a document on that conversation. The mark that refused it (`quota.ts`) says when the provider may
 * work again — the reset it named, or the retry interval — and the conversation's first input after that moment goes
 * back to the model its family names, with one `models.fallback` entry saying so. Nothing sweeps another family along:
 * the pending move names `review`, and only a move of that family writes one.
 *
 * A choice the user made meanwhile wins and drops the pending move: another model for the conversation, or a family
 * whose model is no longer the one this conversation left. Only the provider's moment moves a conversation back, never
 * an assumption, and the mark is the only clock, so a restart changes nothing.
 */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc, defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { hasLogin } from '../../lib/agents.ts'
import { refName, refOf } from '../../lib/families.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { Quota } from './quota.ts'
import type { Fallback } from './refs.ts'

/** The family this rule applies to, named so it cannot reach any other. */
export const REVIEW_FAMILY = 'review'

/** A move that is due back: the family it left, the model that family names, and where the conversation runs until. */
export type Switchback = { family: string; from: string; to: string }

/** The move a conversation owes back, on that conversation. */
export const SwitchbackDoc = defineDoc<{ pending?: Switchback }>({
  kind: 'models.switchback',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({}),
})

const name = (ref: { provider: string; modelId: string }) => `${ref.provider}/${ref.modelId}`

/** Record that this conversation left `from` for `to` and goes back when the model that refused is due. */
export async function movedOut(tx: Tx, conversationId: ConversationId, pending: Switchback) {
  const state = await tx.doc(SwitchbackDoc, conversationId)
  state.pending = pending
}

/**
 * Whether this conversation owes a move back and its moment has come. When it does, the conversation's agent runs on the
 * model its family names again and the entry says so; a pending move the user has since made pointless is dropped.
 */
export async function switchBack(
  host: ExtensionHost,
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ entries: EntryDraft[] } | undefined> {
  const state = await tx.doc(SwitchbackDoc, conversationId)
  const pending = state.pending
  if (!pending) return undefined
  const drop = () => {
    delete state.pending
    return undefined
  }
  const agent = await tx.doc(AgentDoc, conversationId)
  // The user picked another model for this conversation meanwhile: that choice is the one it should keep.
  if (!agent.model || name(agent.model) !== pending.to) return drop()
  const runtime = host.modelRuntime
  const config = await readFamilies(host.userHome, host.projectRoot, await host.projectSettings())
  const target = refOf(config.families[pending.family]?.model)
  // The family names another model now: the move back is no longer the one written down, so it is dropped rather than
  // turned into a different one.
  if (!target || refName(target) !== pending.from) return drop()
  // A login the snapshot does not show is no evidence that it is gone — an empty snapshot says nothing, and one taken
  // before a login was refreshed does not either (`fallback.ts` draws the same line), so the move is kept and tried
  // again on the next input instead of thrown away.
  if (!hasLogin(runtime.getAvailableSnapshot(), target)) return undefined
  const marks = await tx.doc(Quota, ROOT_CONVERSATION_ID)
  // The mark is the only clock there is: without it nothing says the model was refused or when to try again. It names
  // the model, so a refusal of another model on the same login leaves this one's moment untouched.
  const mark = marks.models[name(target)]
  if (!mark) return drop()
  if (mark.until > Date.now()) return undefined
  agent.model = target
  const model = runtime.getModel(target.provider, target.modelId)
  if (model && agent.thinkingLevel)
    agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
  delete state.pending
  const data: Fallback = { from: pending.to, to: pending.from, reason: 'reset' }
  return {
    entries: [
      {
        kind: 'models.fallback',
        data,
        model: [
          {
            role: 'user',
            content: `${pending.from} has quota again; this conversation runs back on it.`,
            timestamp: Date.now(),
          },
        ],
      },
    ],
  }
}
