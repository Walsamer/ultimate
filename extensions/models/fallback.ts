/**
 * A conversation whose model provider either has no login here or refused its last request for a spent account (a
 * quota, a usage limit, a rate limit Pi already retried) switches, as its next run's input is placed, to the same
 * model on another provider, the model its definition runs on, the fallback its family names or the configured
 * default, and says so with one `models.fallback` entry. A subscription never switches to a pay-per-token login: then
 * nothing replaces it, the conversation keeps its model and the entry asks the user. An availability Pi has not
 * settled switches nothing.
 */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { configuredModel, hasLogin } from '../../lib/agents.ts'
import { DEFAULT_FAMILY, familyFallback, refOf } from '../../lib/families.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { Definition } from './api.ts'
import { Quota, spent } from './quota.ts'
import type { Fallback } from './refs.ts'

type Ref = { provider: string; modelId: string }
const name = (ref: Ref) => `${ref.provider}/${ref.modelId}`

/**
 * Claude runs on its subscription only through Claude Code, never inside Pi; Pi marks its `anthropic` OAuth a
 * subscription, but here that provider is the pay-per-token Anthropic API, so a fallback never treats it as one.
 */
const BILLED = new Set(['anthropic'])

/** Whether `provider`'s login is a subscription, as Pi marks it: an OAuth login whose provider says `isSubscription`. */
function subscription(host: ExtensionHost, provider: string) {
  return !BILLED.has(provider) && host.modelRuntime.isUsingSubscription(provider)
}

export async function fallback(
  host: ExtensionHost,
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ entries: EntryDraft[] } | undefined> {
  const agent = await tx.doc(AgentDoc, conversationId)
  const runtime = host.modelRuntime
  const available = runtime.getAvailableSnapshot()
  // Nothing has a login yet (an empty snapshot says nothing about this model).
  if (!agent.model || !available.length) return undefined
  const from = agent.model
  const now = Date.now()
  const marks = await tx.doc(Quota, ROOT_CONVERSATION_ID)
  // It refused its last request for a spent account; a login is not the problem and needs no check.
  const refused = spent(marks, from.provider, now)
  // This one still has a login and has not run out of quota.
  if (!refused && hasLogin(available, from)) return undefined
  // Certain evidence only: the snapshot has no login for it and a fresh check agrees. A provider still registering,
  // or a check that fails or times out, leaves the model as it is; its request fails with its own error.
  if (!refused && runtime.getProvider(from.provider) && (await mayHaveLogin(host, from.provider)))
    return undefined
  const fresh = runtime.getAvailableSnapshot()
  const paid = wasSubscription(host, from.provider) || subscription(host, from.provider)
  // Another provider that has a login and has not just refused for a spent account; a subscription takes only
  // another subscription.
  const allowed = (provider: string) =>
    !spent(marks, provider, now) && (!paid || subscription(host, provider))
  const usable = (ref: Ref | undefined) => !!ref && hasLogin(fresh, ref) && allowed(ref.provider)
  const same = fresh.find(
    (model) =>
      model.id === from.modelId && model.provider !== from.provider && allowed(model.provider),
  )
  // What the conversation's agent definition runs on, and the families as settings have them now: the definition's
  // own model, then its family's declared fallback, then the configured default. The family's fallback is what lets a
  // default family that is itself the spent provider hand over, since it can name a model the chain would never reach.
  const runs = await host.want(Definition)?.runs(tx, conversationId)
  const config = await readFamilies(host.userHome, host.projectRoot, await host.projectSettings())
  const candidates: [Ref | undefined, Fallback['reason']][] = [
    [same && { provider: same.provider, modelId: same.id }, 'same'],
    [runs?.model, 'pin'],
    [familyFallback(config, runs?.family), 'family'],
    [
      configuredModel(fresh, host.settings, refOf(config.families[DEFAULT_FAMILY].model)),
      'default',
    ],
  ]
  const found = candidates.find(([ref]) => usable(ref))
  const reason: Fallback['reason'] = refused ? 'quota' : found ? found[1] : 'none'
  const data: Fallback = found
    ? { from: name(from), to: name(found[0]!), reason }
    : { from: name(from), reason }
  if (!found && (await alreadyAsked(tx, conversationId, data))) return undefined
  if (found) {
    const to = found[0]!
    agent.model = { provider: to.provider, modelId: to.modelId }
    const model = runtime.getModel(to.provider, to.modelId)
    if (model && agent.thinkingLevel)
      agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
  }
  const content = found
    ? refused
      ? `${data.from} is out of quota here; this conversation now runs on ${data.to}.`
      : `Model ${data.from} has no login here; this conversation now runs on ${data.to}.`
    : refused
      ? `${data.from} is out of quota here and nothing else has a login to take over, so this conversation keeps it until the quota resets or the user picks another model.`
      : `Model ${data.from} has no login here and no subscription login can replace it, so this conversation keeps it until the user logs in to ${from.provider} or picks another model.`
  return {
    entries: [
      { kind: 'models.fallback', data, model: [{ role: 'user', content, timestamp: Date.now() }] },
    ],
  }
}

/** How long the fresh check may take; it runs inside the input's transaction, and only when a login looks gone. */
const CHECK_MS = 5_000

/**
 * Check `provider`'s login again now, as Pi does: true when it has one after all (the snapshot was stale or still
 * pending), and when the check fails or times out, since that is no evidence either way.
 */
async function mayHaveLogin(host: ExtensionHost, provider: string) {
  try {
    return !!(await host.modelRuntime.checkAuth(provider, {
      signal: AbortSignal.timeout(CHECK_MS),
    }))
  } catch (error) {
    host.notice(`Checking the ${provider} login failed, keeping the model: ${String(error)}`)
    return true
  }
}

/**
 * Pi's subscription mark of a provider whose login is gone, so its login type is no longer known: its OAuth method
 * says `isSubscription`.
 */
function wasSubscription(host: ExtensionHost, provider: string) {
  return (
    !BILLED.has(provider) &&
    host.modelRuntime.getProvider(provider)?.auth.oauth?.isSubscription === true
  )
}

/** Whether this conversation's newest fallback entry already says what this one would, so each next input says it once. */
async function alreadyAsked(tx: Tx, conversationId: ConversationId, data: Fallback) {
  for (let page = await tx.scanEntries({ conversationId }, 200); ;) {
    const entry = page.items.find((item) => item.kind === 'models.fallback')
    if (entry) {
      const previous = entry.data as Fallback
      return (
        previous.to === undefined && previous.from === data.from && previous.reason === data.reason
      )
    }
    if (!page.next) return false
    page = await tx.scanEntries({ conversationId }, 200, page.next)
  }
}
