/**
 * A model that refused a request because it cannot serve it here — the account behind its login is spent (a quota, a
 * usage limit, an empty prepaid balance, a gateway's exhausted token allocation, a rate limit Pi already retried), the
 * provider has no such model or no permission for it, or the provider kept failing on its own side (`modelBlocked` in
 * `lib/rate-limit.ts`) — is marked until the moment it may work again, so the fallback keeps a conversation from walking
 * into the same wall (`fallback.ts`) and knows when to try it again. The mark names the model, not the provider: a
 * gateway serves a whole family chain on the same login, and one refused model must not take its siblings down with it.
 * It is a document on the root, so it survives a restart and every conversation of this home reads it. The moment is the
 * reset the refusal names (`resetAt` in `lib/rate-limit.ts`) when it names one; otherwise a spent account waits the retry
 * interval (`RETRY_MINUTES`, or the project's `quotaRetryMinutes`) and a provider's own failure only a short blip.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineDoc, GenerationTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { CommitPublication, ConversationId, TaskRecord } from '@earendil-works/pi-durable'
import { modelBlocked, outOfQuota, resetAt, transient } from '../../lib/rate-limit.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/**
 * How long a model that names no reset is left alone before a conversation tries it again; the project's settings raise
 * or lower it with `quotaRetryMinutes`, a whole number of minutes from one minute to a day. Every attempt against a
 * model that is still spent costs one lost run, so this is a patience setting rather than a cooldown: ten minutes
 * catches a limit that reset early, and a limit measured in days is probed at that rate rather than on every review.
 */
export const RETRY_MINUTES = 10

/**
 * How long a provider's own failure (5xx, overloaded, a broken stream) is left alone when it names no reset: it may pass
 * on its own, so the next runs try the preferred model again soon instead of the chain keeping it out for the whole
 * retry interval.
 */
export const BLIP_MS = 2 * 60_000

/** The range a project's `quotaRetryMinutes` may take: shorter is a probe storm, longer outlives any quota window. */
const RETRY_LIMITS = { min: 1, max: 24 * 60 }

/**
 * One refused model: when it refused, until when it is left alone, and whether the account is spent (`quota`) or the
 * model itself is not served here (`refused`).
 */
export type Refusal = { at: number; until: number; reason: 'quota' | 'refused' }

/**
 * `{ models: { 'provider/id': { at, until, reason } } }`: when a model refused, when to try it again, and why. Version 2
 * keys by model where version 1 keyed by provider, so a mark left by an older build cannot keep a whole gateway out.
 */
export const Quota = defineDoc<{ models: Record<string, Refusal> }>({
  kind: 'models.quota',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ models: {} }),
  migrate: () => ({ models: {} }),
})

/** The mark that covers `ref` now, if its moment to try again has not come: this model refused its last request here. */
export const refusal = (
  marks: { models: Record<string, Refusal> },
  ref: { provider: string; modelId: string },
  now: number,
) => {
  const found = marks.models[`${ref.provider}/${ref.modelId}`]
  return found && found.until > now ? found : undefined
}

type Generation = TaskRecord<JsonValue, JsonValue, JsonValue>

/** The error of a run that ended because the provider refused its model rather than the request or the login breaking. */
const blocked = (task: Generation) =>
  task.kind === GenerationTask.definition.name &&
  task.state.status === 'terminal' &&
  task.state.outcome.status === 'failed' &&
  (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason === 'model_error' &&
  modelBlocked(task.state.outcome.error.message)
    ? task.state.outcome.error.message
    : undefined

/**
 * The model that refused: the answer that ended the run names it. Without one there is nothing to mark — a run that fails
 * before it asks a model names no model, and marking the conversation's current one could blame the model the user
 * picked meanwhile.
 */
function refusedBy(publication: CommitPublication, conversationId: ConversationId) {
  for (const change of publication.changes) {
    if (change.type !== 'entry' || change.value.conversationId !== conversationId) continue
    const message = change.value.model?.[0]
    if (message?.role === 'assistant' && message.stopReason === 'error')
      return {
        provider: message.provider,
        modelId: message.model,
        error: message.errorMessage ?? '',
      }
  }
  return undefined
}

/**
 * Mark each model that refuses a run. The failure is already durable when a listener sees it, so the mark is a commit of
 * its own, and the fallback's next input reads it.
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
        if (change.type !== 'task') continue
        const error = blocked(change.value)
        if (error === undefined) continue
        const model = refusedBy(publication, change.value.conversationId)
        if (model === undefined) continue
        queue = queue
          .then(() => mark(host, { ...model, error }))
          .catch((failure: unknown) =>
            host.notice(`Recording a refused model failed: ${String(failure)}`),
          )
      }
    })
  })
}

async function mark(
  host: ExtensionHost,
  model: { provider: string; modelId: string; error: string },
) {
  const now = Date.now()
  const until =
    resetAt(model.error, now) ??
    now + (transient(model.error) ? BLIP_MS : (await retryMinutes(host)) * 60_000)
  await host.harness().commit(async (tx) => {
    const marks = await tx.doc(Quota, ROOT_CONVERSATION_ID)
    marks.models[`${model.provider}/${model.modelId}`] = {
      at: now,
      until,
      reason: outOfQuota(model.error) ? 'quota' : 'refused',
    }
  }, context)
}

/** The project's patience for a model that names no reset; a value outside the range is ignored. */
async function retryMinutes(host: ExtensionHost) {
  const value = (await host.projectSettings()).quotaRetryMinutes
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= RETRY_LIMITS.min &&
    value <= RETRY_LIMITS.max
    ? value
    : RETRY_MINUTES
}
