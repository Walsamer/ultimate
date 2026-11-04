/**
 * A conversation whose model either has no login here or refused its last request for a reason another model would not
 * share (`modelBlocked` in `lib/rate-limit.ts`: a spent account, a model the provider does not serve or allows here, or
 * a provider that kept failing on its own side) switches, as its next run's input is placed, to the same model on
 * another provider, the model its definition runs on, the first fallback its family names that is usable or the
 * configured default, and says so with one `models.fallback` entry. A family names one fallback or an ordered list of
 * them, each refusal walking one step further; a refused model is marked (`quota.ts`) for a cooldown, and the mark
 * names the model rather than the provider, so a gateway that serves a whole chain on one login gives up only the model
 * that refused. A subscription switches only to another subscription login,
 * except for the fallback its own family names: that is the owner saying where to spend instead, so that one step may
 * move it to a login billed per token, and the entry and its card say the provider is billed. Without such a
 * fallback nothing replaces it, the conversation keeps its model and the entry asks the user. An availability Pi has
 * not settled switches nothing.
 */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { configuredModel, hasLogin } from '../../lib/agents.ts'
import { DEFAULT_FAMILY, familyFallbacks, refOf } from '../../lib/families.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { Definition } from './api.ts'
import { Quota, refusal } from './quota.ts'
import type { Refusal } from './quota.ts'
import type { Fallback } from './refs.ts'

type Ref = { provider: string; modelId: string }
/** The step of the chain that picked a model: which one it is decides whether it may leave a subscription. */
type Step = 'same' | 'pin' | 'family' | 'default'
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
  // This model refused its last request here; a login is not the problem and needs no check.
  const mark: Refusal | undefined = refusal(marks, from, now)
  // This one still has a login and has not refused its last request.
  if (!mark && hasLogin(available, from)) return undefined
  // Certain evidence only: the snapshot has no login for it and a fresh check agrees. A provider still registering,
  // or a check that fails or times out, leaves the model as it is; its request fails with its own error.
  if (!mark && runtime.getProvider(from.provider) && (await mayHaveLogin(host, from.provider)))
    return undefined
  const fresh = runtime.getAvailableSnapshot()
  const paid = wasSubscription(host, from.provider) || subscription(host, from.provider)
  // Another model that has a login and did not refuse its last request here. A subscription takes only another
  // subscription, except for the fallback its family names: the owner wrote that step down, so it is no silent switch
  // to a billed login, and the entry says what it crossed into. Nothing else may cross.
  const allowed = (ref: Ref, step: Step) =>
    !refusal(marks, ref, now) && (!paid || step === 'family' || subscription(host, ref.provider))
  const usable = (ref: Ref | undefined, step: Step) =>
    !!ref && hasLogin(fresh, ref) && allowed(ref, step)
  const same = fresh.find(
    (model) =>
      model.id === from.modelId &&
      model.provider !== from.provider &&
      allowed({ provider: model.provider, modelId: model.id }, 'same'),
  )
  // What the conversation's agent definition runs on, and the families as settings have them now: the definition's
  // own model, then its family's declared fallbacks, then the configured default. The family's fallback is what lets a
  // default family that is itself the spent provider hand over, since it can name a model the chain would never reach;
  // an ordered list is walked from its first entry, one candidate per step, and the first one that is usable wins.
  const runs = await host.want(Definition)?.runs(tx, conversationId)
  const config = await readFamilies(host.userHome, host.projectRoot, await host.projectSettings())
  const candidates: [Ref | undefined, Step][] = [
    [same && { provider: same.provider, modelId: same.id }, 'same'],
    [runs?.model, 'pin'],
    ...familyFallbacks(config, runs?.family).map((ref): [Ref, Step] => [ref, 'family']),
    [
      configuredModel(fresh, host.settings, refOf(config.families[DEFAULT_FAMILY].model)),
      'default',
    ],
  ]
  const found = candidates.find(([ref, step]) => usable(ref, step))
  const reason: Fallback['reason'] = mark ? mark.reason : found ? found[1] : 'none'
  // The move left the subscription for a login billed per token; the entry and its card say so plainly.
  const billed = !!found && paid && !subscription(host, found[0]!.provider)
  const data: Fallback = found
    ? { from: name(from), to: name(found[0]!), reason, ...(billed ? { billed: true } : {}) }
    : { from: name(from), reason }
  if (!found && (await alreadyAsked(tx, conversationId, data))) return undefined
  if (found) {
    const to = found[0]!
    agent.model = { provider: to.provider, modelId: to.modelId }
    const model = runtime.getModel(to.provider, to.modelId)
    if (model && agent.thinkingLevel)
      agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
  }
  const spending = billed ? ', billed per token' : ''
  // A spent account says so plainly; any other refusal names the model, since the login is fine there.
  const why =
    mark?.reason === 'quota'
      ? `${data.from} is out of quota here`
      : mark
        ? `${data.from} refused its last request here`
        : undefined
  const content = found
    ? why
      ? `${why}; this conversation now runs on ${data.to}${spending}.`
      : `Model ${data.from} has no login here; this conversation now runs on ${data.to}${spending}.`
    : why
      ? `${why} and nothing else this conversation may move to has a login, so this conversation keeps it until it is usable again or the user picks another model.`
      : `Model ${data.from} has no login here and no other model this conversation may move to has a login, so this conversation keeps it until the user logs in to ${from.provider} or picks another model.`
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
