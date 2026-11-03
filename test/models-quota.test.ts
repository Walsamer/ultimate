import { until } from './helpers.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory, FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { outOfQuota } from '../lib/rate-limit.ts'
import models from '../extensions/models/server.ts'
import { Quota, spent } from '../extensions/models/quota.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import watchdog from '../extensions/watchdog/server.ts'
import { Metadata } from '../server/metadata.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { temp } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

/** What OpenAI answers when the plan behind a login is used up: Pi does not retry it. */
const quota =
  '429 You exceeded your current quota, please check your plan and billing details. (insufficient_quota)'
const model = { provider: 'faux', modelId: 'faux-1' }
const other = { provider: 'faux2', modelId: 'faux-2' }

type Answer = (text: string) => FauxResponseStep

/** Owns a subagent's conversation, as a parent's running tool does. */
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'quota-test.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        ctx,
      ),
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})

const textOf = (transcript: Parameters<FauxResponseFactory>[0]) => {
  const message = transcript.messages.findLast((candidate) => candidate.role !== 'system')!
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}
const error = (text: string) =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage: text })

/**
 * A harness running the real models and watchdog backends: the first provider refuses for a spent account, and the
 * conversation should finish on the next one the chain picks. The clock is the harness's, so a watchdog continuation
 * costs nothing. The third provider is only ever reached through the configured default, so a test can tell a family's
 * fallback from the default the chain ends at.
 */
async function fixture(
  answers: { primary: Answer; fallback?: Answer; third?: Answer },
  options: {
    subscriptions?: string[]
    /** The providers with a login here, every one by default (the availability snapshot and `checkAuth` agree). */
    signedIn?: string[]
    /** The model the chain's last step resolves to: `faux2/faux-2` unless a test says otherwise. */
    configured?: { provider: string; modelId: string }
    /** What a conversation's agent definition runs on, as the subagents extension reports it. */
    definition?: { family?: string; model?: { provider: string; modelId: string } }
    /** The project settings' `modelFamilies`. */
    families?: unknown
  } = {},
) {
  let now = 1_000_000
  const registry = createRegistry()
  const runtime = createModels()
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] })
  const alt = fauxProvider({ provider: 'faux2', models: [{ id: 'faux-2' }] })
  const third = fauxProvider({ provider: 'faux3', models: [{ id: 'faux-3' }] })
  runtime.setProvider(faux.provider)
  runtime.setProvider(alt.provider)
  runtime.setProvider(third.provider)
  const asked: Record<string, string[]> = { faux: [], faux2: [], faux3: [] }
  const arm = (provider: typeof faux, name: string, answer: Answer) => {
    const route: FauxResponseFactory = (transcript, ...rest) => {
      provider.appendResponses([route])
      const text = textOf(transcript)
      asked[name].push(text)
      const step = answer(text)
      return typeof step === 'function' ? step(transcript, ...rest) : step
    }
    provider.setResponses([route])
  }
  arm(faux, 'faux', answers.primary)
  arm(alt, 'faux2', answers.fallback ?? (() => fauxAssistantMessage('the fallback answer')))
  arm(third, 'faux3', answers.third ?? (() => fauxAssistantMessage('the third answer')))
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const settings = { retry: { maxRetries: 0 } }
  let harness = await Harness.open(
    storage,
    { models: runtime, registry, now: () => now, settings },
    context,
  )
  // The providers with a login here, as the snapshot reports them; a marked provider is the only other reason to move.
  const signedIn = new Set(options.signedIn ?? ['faux', 'faux2', 'faux3'])
  const available = [
    { provider: 'faux', id: 'faux-1' },
    { provider: 'faux2', id: 'faux-2' },
    { provider: 'faux3', id: 'faux-3' },
  ].filter((entry) => signedIn.has(entry.provider))
  const configured = options.configured ?? other
  const subscriptions = new Set(options.subscriptions ?? [])
  const home = await temp('ultimate-quota-')
  const notices: string[] = []
  const resources = new Map<string, unknown>()
  const onOpen: (() => Promise<void>)[] = []
  const onClose: (() => Promise<void>)[] = []
  const onRelease: (() => Promise<void>)[] = []
  const host = {
    harness: () => harness,
    modelRuntime: {
      getAvailableSnapshot: () => available,
      getProvider: (provider: string) => runtime.getProvider(provider),
      isUsingSubscription: (provider: string) => subscriptions.has(provider),
      checkAuth: async (provider: string) =>
        available.some((entry) => entry.provider === provider) ? { type: 'api_key' } : undefined,
      getModel: (provider: string, id: string) => runtime.getModel(provider, id),
    },
    settings: {
      getDefaultProvider: () => configured.provider,
      getDefaultModel: () => configured.modelId,
    },
    // The definition a conversation runs as, when a test gives it one: the model it runs on, else its family's
    // fallback, is what takes over.
    want: (api: { name: string }) =>
      api.name === 'models.definition' && options.definition
        ? { runs: async () => options.definition }
        : undefined,
    projectSettings: async () =>
      options.families === undefined ? {} : { modelFamilies: options.families },
    notice: (text: string) => notices.push(text),
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: (callback: () => Promise<void>) => onOpen.push(callback),
    onClose: (callback: () => Promise<void>) => onClose.push(callback),
    onRelease: (callback: () => Promise<void>) => onRelease.push(callback),
    metadata: Metadata,
    scanSubmissions: (...args: Parameters<MemoryStorage['scanSubmissions']>) =>
      storage.scanSubmissions(...args),
    implement: () => {},
    // The watchdog's idle note runs when a card reaches @ultimate; this home has no branch bookkeeping.
    need: (api: { name: string }) =>
      api.name === 'conversations'
        ? { concludedIn: async () => new Set<number>() }
        : { doc: Workspaces },
    userHome: home,
    projectRoot: home,
  } as unknown as ExtensionHost
  registry.install(models(host))
  registry.install(watchdog(host))
  registry.install(defineExtension({ name: 'quota-test', tasks: [Anchor] }))
  // The root holds the watchdog's receipts and this home's quota marks; it is @ultimate, which gets the cards.
  const { id: ultimate } = await harness.root(context, { agent: { model } })
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate
    Object.assign(await tx.doc(Metadata, ultimate), { title: '@ultimate' })
  }, context)
  const open = async () => {
    for (const callback of onOpen) await callback()
    harness.resume()
  }
  await open()
  cleanups.push(async () => {
    for (const callback of onClose) await callback()
    for (const callback of onRelease) await callback()
    await harness.close(context)
  })
  /** A conversation of its own, or a subagent's, owned by a task of `owner` as a running tool makes one. */
  const conversation = async (title: string, owner?: ConversationId) =>
    harness.commit(async (tx) => {
      const anchor =
        owner === undefined
          ? undefined
          : await tx.createTask(Anchor, null, {
              conversationId: owner,
              ownership: { kind: 'conversation' },
            })
      const child = await tx.createConversation({
        ownership: anchor === undefined ? { kind: 'ownerless' } : { kind: 'task', taskId: anchor },
      })
      await configure(tx, child.id, { model })
      Object.assign(await tx.doc(Metadata, child.id), { title })
      return child.id
    }, context)
  const entries = async (id: ConversationId, kind?: string): Promise<EntryRecord[]> =>
    (
      await harness.commit(
        (tx) => tx.scanEntries({ conversationId: id, order: 'ascending' }, 500),
        context,
      )
    ).items.filter((entry) => kind === undefined || entry.kind === kind)
  const marks = async () =>
    (await harness.snapshot(Quota, ROOT_CONVERSATION_ID, context))?.providers ?? {}
  const agent = async (id: ConversationId) =>
    (await harness.conversation(id, context))!.agent(context)
  const tasks = async (kind: string) =>
    (await harness.commit((tx) => tx.scanTasks({ kind }, 100), context)).items
  return {
    get harness() {
      return harness
    },
    ultimate,
    notices,
    asked,
    conversation,
    entries,
    marks,
    agent,
    tasks,
    submit: async (id: ConversationId, content: string) =>
      (await harness.conversation(id, context))!.submit({ type: 'input', content }, context),
    /** Move the harness clock past the watchdog's retry deadline and let it run. */
    deadline: async () => {
      now += 60_000
      harness.resume()
    },
  }
}
const fallbacks = (entries: EntryRecord[]) =>
  entries.filter((entry) => entry.kind === 'models.fallback')

it('reads a spent account out of provider errors, and nothing else', () => {
  const refused = [
    quota,
    'You exceeded your current quota, please check your plan and billing details.',
    "You've hit your usage limit. Upgrade to Plus or try again in 3 days.",
    'Insufficient Balance',
    '429 Too Many Requests',
    "Incomplete Claude Code upstream response (status 429, capture incomplete, upstream said: This request would exceed your account's rate limit. Please try again later.)",
  ]
  const not = [
    'Our servers are currently overloaded. Please try again later.',
    'Overloaded (529)',
    'Internal server error (500)',
    'Invalid model configuration',
    'fetch failed: ECONNREFUSED 127.0.0.1:443',
    'Claude Code billing: this request was charged to Claude usage credits instead of your plan limits (rate limit status allowed_warning, five_hour).',
  ]
  expect(refused.filter(outOfQuota)).toEqual(refused)
  expect(not.filter(outOfQuota)).toEqual([])
})

it('marks a provider that runs out of quota, and the next run finishes on the fallback with one entry', async () => {
  const f = await fixture({ primary: () => error(quota) })
  const branch = await f.conversation('Write the review')
  const run = await f.submit(branch, 'review it')
  // The run itself fails: a model cannot switch under one request.
  expect(await run.wait(context)).toMatchObject({ status: 'unanswered', reason: 'model_error' })
  await until(async () => (await f.marks()).faux !== undefined)
  expect(Object.keys(await f.marks())).toEqual(['faux'])
  expect(await f.agent(branch)).toMatchObject({ model })
  // One continuation, on the provider that still has quota: the work finishes there and says why.
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  expect(f.asked.faux2[0]).toContain('Continue from where you left off')
  expect(await f.agent(branch)).toMatchObject({ model: other })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  // The notice the model reads names both models.
  expect(fallbacks(await f.entries(branch))[0].model?.[0]?.content).toBe(
    'faux/faux-1 is out of quota here; this conversation now runs on faux2/faux-2.',
  )
  // The continuation is the answer: the review was written on the fallback, not on the provider that refused it.
  const answer = (await f.entries(branch)).findLast((entry) => entry.kind === 'pi.assistant')
  expect(answer?.model?.[0]).toMatchObject({ provider: 'faux2', model: 'faux-2' })
  // One entry ever, not one per input afterwards: the next input runs where the conversation already is.
  await (await f.submit(branch, 'and again')).wait(context)
  expect(f.asked.faux2).toHaveLength(2)
  expect(fallbacks(await f.entries(branch))).toHaveLength(1)
  expect(await f.tasks('watchdog.failure')).toHaveLength(1)
  // Nothing was reported as failed: the fallback finished the work.
  expect(await f.entries(f.ultimate, 'watchdog.failure')).toEqual([])
})

it("finishes a subagent's review on the fallback and tells its parent nothing failed", async () => {
  const f = await fixture({ primary: () => error(quota) })
  const parent = await f.conversation('Coordinate the review')
  const reviewer = await f.conversation('Review the range', parent)
  await (await f.submit(reviewer, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  // The reviewer's own conversation finished on the fallback: a reviewer is no different from any other reader.
  const answer = (await f.entries(reviewer)).findLast((entry) => entry.kind === 'pi.assistant')
  expect(answer?.model?.[0]).toMatchObject({ provider: 'faux2', model: 'faux-2' })
  expect(fallbacks(await f.entries(reviewer)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  expect(await f.entries(parent, 'watchdog.failure')).toEqual([])
  expect(await f.entries(f.ultimate, 'watchdog.failure')).toEqual([])
})

it('reports a second failure on the fallback instead of trying a third model', async () => {
  const f = await fixture({
    primary: () => error(quota),
    fallback: () => error(quota),
  })
  const branch = await f.conversation('Write the review')
  await (await f.submit(branch, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => (await f.entries(f.ultimate, 'watchdog.failure')).length === 1)
  const [failure] = await f.entries(f.ultimate, 'watchdog.failure')
  expect(failure.data).toMatchObject({ conversation: branch, error: quota, retried: true })
  expect(failure.data).toHaveProperty(
    'hint',
    'The provider is out of quota; once it resets, resume this conversation with a message',
  )
  // At most one attempt: no third model, no second continuation, and the entry says only the first switch.
  expect(f.asked.faux).toHaveLength(1)
  expect(f.asked.faux2).toHaveLength(1)
  expect(Object.keys(await f.marks()).toSorted()).toEqual(['faux', 'faux2'])
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
})

it.each([
  ['a refused server', 'Internal server error (500)'],
  ['a network error', 'fetch failed: ECONNREFUSED 127.0.0.1:443'],
])('%s switches no model and marks nothing', async (_kind, text) => {
  const f = await fixture({ primary: () => error(text) })
  const branch = await f.conversation('Write the review')
  await (await f.submit(branch, 'review it')).wait(context)
  // Whatever the watchdog does with such an error, the model layer never moves the conversation.
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(Object.keys(await f.marks())).toEqual([])
  expect(fallbacks(await f.entries(branch))).toEqual([])
  expect(await f.agent(branch)).toMatchObject({ model })
})

it('moves a subscription conversation only to another subscription login', async () => {
  const one = await fixture({ primary: () => error(quota) }, { subscriptions: ['faux', 'faux2'] })
  const paid = await one.conversation('Write the review')
  await (await one.submit(paid, 'review it')).wait(context)
  await until(async () => (await one.marks()).faux !== undefined)
  await one.deadline()
  await until(async () => (await one.entries(paid, 'models.fallback')).length === 1)
  // Two subscriptions: the run continues on the other one.
  expect(await one.agent(paid)).toMatchObject({ model: other })
  expect(fallbacks(await one.entries(paid)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  const f = await fixture({ primary: () => error(quota) }, { subscriptions: ['faux'] })
  const branch = await f.conversation('Write the review')
  await (await f.submit(branch, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => (await f.entries(branch, 'models.fallback')).length === 1)
  // nothing replaces a subscription login with a pay-per-token one: the model stays and the entry asks the user.
  expect(await f.agent(branch)).toMatchObject({ model })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', reason: 'quota' },
  ])
  expect(f.asked.faux2).toEqual([])
})

it('moves a conversation to the fallback its family names, before the configured default', async () => {
  // A `fast` agent: its family's model refused for a spent account, and the family names the model to move to. The
  // configured default is a third provider, so this cannot pass on the chain's last step.
  const f = await fixture(
    { primary: () => error(quota) },
    {
      definition: { family: 'fast', model },
      families: { families: { fast: { model: 'faux/faux-1', fallback: 'faux2/faux-2' } } },
      configured: { provider: 'faux3', modelId: 'faux-3' },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  expect(await f.agent(branch)).toMatchObject({ model: other })
  // A quota move says so in the reason; the model it moved to shows which step chose it. The configured default
  // (faux3) never runs: the chain stopped at the family's fallback.
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  expect(f.asked.faux3).toEqual([])
  // Without a definition (@ultimate, a branch) the conversation runs on the default family, whose fallback applies.
  const plain = await fixture(
    { primary: () => error(quota) },
    {
      families: { families: { default: { fallback: 'faux2/faux-2' } } },
      configured: { provider: 'faux3', modelId: 'faux-3' },
    },
  )
  const plainBranch = await plain.conversation('Write the review')
  await (await plain.submit(plainBranch, 'review it')).wait(context)
  await until(async () => (await plain.marks()).faux !== undefined)
  await plain.deadline()
  await until(async () => plain.asked.faux2.length === 1)
  expect(fallbacks(await plain.entries(plainBranch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  expect(plain.asked.faux3).toEqual([])
})

it("takes a family's fallback when its model's login is gone, and says which step it was", async () => {
  const f = await fixture(
    { primary: () => fauxAssistantMessage('the answer') },
    {
      signedIn: ['faux2'],
      definition: { family: 'fast' },
      families: { families: { fast: { fallback: 'faux2/faux-2' } } },
      configured: { provider: 'faux3', modelId: 'faux-3' },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.entries(branch, 'models.fallback')).length === 1)
  expect(await f.agent(branch)).toMatchObject({ model: other })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'family' },
  ])
})

it("keeps today's chain when the family names no fallback", async () => {
  const f = await fixture(
    { primary: () => error(quota) },
    {
      definition: { family: 'fast', model },
      families: { families: { fast: { model: 'faux/faux-1' } } },
      configured: { provider: 'faux3', modelId: 'faux-3' },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux3.length === 1)
  expect(await f.agent(branch)).toMatchObject({ model: { provider: 'faux3', modelId: 'faux-3' } })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux3/faux-3', reason: 'quota' },
  ])
  expect(f.asked.faux2).toEqual([])
})

it("never moves a subscription conversation to its family's pay-per-token fallback", async () => {
  const f = await fixture(
    { primary: () => error(quota) },
    {
      subscriptions: ['faux', 'faux3'],
      definition: { family: 'fast', model },
      families: { families: { fast: { model: 'faux/faux-1', fallback: 'faux2/faux-2' } } },
      configured: { provider: 'faux3', modelId: 'faux-3' },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux3.length === 1)
  // faux2 is pay-per-token: the family's fallback is skipped, and the chain's subscription-safe step takes over.
  expect(f.asked.faux2).toEqual([])
  expect(await f.agent(branch)).toMatchObject({ model: { provider: 'faux3', modelId: 'faux-3' } })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux3/faux-3', reason: 'quota' },
  ])
})

it('leaves a provider alone until its cooldown runs out, then lets it be chosen again', () => {
  const marks = { providers: { faux: { at: 1_000, until: 2_000 } } }
  expect(spent(marks, 'faux', 1_500)).toBe(true)
  expect(spent(marks, 'faux', 2_000)).toBe(false)
  expect(spent(marks, 'faux2', 1_500)).toBe(false)
  expect(spent({ providers: {} }, 'faux', 1_500)).toBe(false)
})
