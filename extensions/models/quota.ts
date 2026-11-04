/**
 * A provider that refused a request because the account behind its login is spent (a quota, a usage limit, an empty
 * prepaid balance, a rate limit Pi already retried) is marked until the moment it may work again, so the fallback keeps
 * a conversation from walking into the same wall (`fallback.ts`) and knows when to try it again. The mark is a document
 * on the root, so it survives a restart and every conversation of this home reads it. The moment is the reset the
 * refusal names (`resetAt` in `lib/rate-limit.ts`); when it names none — Codex says only "The usage limit has been
 * reached" — the mark lasts the retry interval instead (`RETRY_MINUTES`, or the project's `quotaRetryMinutes`).
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineDoc, GenerationTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { CommitPublication, ConversationId, TaskRecord } from '@earendil-works/pi-durable'
import { outOfQuota, resetAt } from '../../lib/rate-limit.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/**
 * How long a provider that names no reset is left alone before a conversation tries it again; the project's settings
 * raise or lower it with `quotaRetryMinutes`, a whole number of minutes from one minute to a day. Every attempt against
 * a provider that is still spent costs one lost run, so this is a patience setting rather than a cooldown: ten minutes
 * catches a limit that reset early, and a limit measured in days is probed at that rate rather than on every review.
 */
export const RETRY_MINUTES = 10

/** The range a project's `quotaRetryMinutes` may take: shorter is a probe storm, longer outlives any quota window. */
const RETRY_LIMITS = { min: 1, max: 24 * 60 }

/** `{ providers: { [provider]: { at, until } } }`: when a provider refused, and when to try it again. */
export const Quota = defineDoc<{ providers: Record<string, { at: number; until: number }> }>({
  kind: 'models.quota',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ providers: {} }),
})

/** Whether `provider` refused for a spent account and its moment to try again has not come. */
export const spent = (
  marks: { providers: Record<string, { until: number }> },
  provider: string,
  now: number,
) => (marks.providers[provider]?.until ?? 0) > now

type Generation = TaskRecord<JsonValue, JsonValue, JsonValue>

/** A run that ended because the provider refused it for a spent account. */
const refusal = (task: Generation) =>
  task.kind === GenerationTask.definition.name &&
  task.state.status === 'terminal' &&
  task.state.outcome.status === 'failed' &&
  (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason === 'model_error' &&
  outOfQuota(task.state.outcome.error.message)
    ? task.state.outcome.error.message
    : undefined

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
        if (change.type !== 'task') continue
        const error = refusal(change.value)
        if (error === undefined) continue
        const provider = refusedBy(publication, change.value.conversationId)
        if (provider === undefined) continue
        queue = queue
          .then(() => mark(host, provider, error))
          .catch((failure: unknown) =>
            host.notice(`Recording a spent quota failed: ${String(failure)}`),
          )
      }
    })
  })
}

async function mark(host: ExtensionHost, provider: string, error: string) {
  const now = Date.now()
  const minutes = await retryMinutes(host)
  const until = resetAt(error, now) ?? now + minutes * 60_000
  await host.harness().commit(async (tx) => {
    const marks = await tx.doc(Quota, ROOT_CONVERSATION_ID)
    marks.providers[provider] = { at: now, until }
  }, context)
}

/** The project's patience for a provider that names no reset; a value outside the range is ignored. */
async function retryMinutes(host: ExtensionHost) {
  const value = (await host.projectSettings()).quotaRetryMinutes
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= RETRY_LIMITS.min &&
    value <= RETRY_LIMITS.max
    ? value
    : RETRY_MINUTES
}
