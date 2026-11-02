/**
 * A provider that refused a request because the account behind its login is spent (a quota, a usage limit, an empty
 * prepaid balance, a rate limit Pi already retried) is marked for a cooldown, so the fallback keeps a conversation from
 * walking into the same wall (`fallback.ts`). The mark is a document on the root, so it survives a restart and every
 * conversation of this home reads it, and it expires, so a limit that reset is used again.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineDoc, GenerationTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { CommitPublication, ConversationId, TaskRecord } from '@earendil-works/pi-durable'
import { outOfQuota } from '../../lib/rate-limit.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/** How long a provider that refused for a spent account is left alone; another refusal while marked extends it. */
export const COOLDOWN_MS = 10 * 60_000

/** `{ providers: { [provider]: { at, until } } }`: when a provider refused, and until when it is left alone. */
export const Quota = defineDoc<{ providers: Record<string, { at: number; until: number }> }>({
  kind: 'models.quota',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ providers: {} }),
})

/** Whether `provider` refused for a spent account and its cooldown has not run out. */
export const spent = (
  marks: { providers: Record<string, { until: number }> },
  provider: string,
  now: number,
) => (marks.providers[provider]?.until ?? 0) > now

type Generation = TaskRecord<JsonValue, JsonValue, JsonValue>

/** A run that ended because the provider refused it for a spent account. */
const refused = (task: Generation) =>
  task.kind === GenerationTask.definition.name &&
  task.state.status === 'terminal' &&
  task.state.outcome.status === 'failed' &&
  (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason === 'model_error' &&
  outOfQuota(task.state.outcome.error.message)

/**
 * The provider that refused: the answer that ended the run names it. Without one there is nothing to mark — a run that
 * fails before it asks a model names no provider, and marking the conversation's current one could blame the model the
 * user picked meanwhile.
 */
function refusedBy(publication: CommitPublication, conversationId: ConversationId) {
  for (const change of publication.changes) {
    if (change.type !== 'entry' || change.value.conversationId !== conversationId) continue
    const message = change.value.model?.[0]
    if (message?.role === 'assistant' && message.stopReason === 'error') return message.provider
  }
  return undefined
}

/**
 * Mark each provider that refuses a run for a spent account. The failure is already durable when a listener sees it, so
 * the mark is a commit of its own, and the fallback's next input reads it.
 */
export function markRefusals(host: ExtensionHost) {
  let queue: Promise<unknown> = Promise.resolve()
  let unsubscribe: (() => void) | undefined
  const stop = async () => {
    unsubscribe?.()
    unsubscribe = undefined
  }
  host.onClose(stop)
  host.onRelease(stop)
  host.onOpen(async () => {
    await stop()
    unsubscribe = host.harness().subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type !== 'task' || !refused(change.value)) continue
        const provider = refusedBy(publication, change.value.conversationId)
        if (provider === undefined) continue
        queue = queue
          .then(() => mark(host, provider))
          .catch((error: unknown) =>
            host.notice(`Recording a spent quota failed: ${String(error)}`),
          )
      }
    })
  })
}

async function mark(host: ExtensionHost, provider: string) {
  await host.harness().commit(async (tx) => {
    const marks = await tx.doc(Quota, ROOT_CONVERSATION_ID)
    const now = Date.now()
    marks.providers[provider] = { at: now, until: now + COOLDOWN_MS }
  }, context)
}
