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
import { afterEach, expect, it, vi } from 'vitest'
import { outOfQuota, resetAt } from '../lib/rate-limit.ts'
import models from '../extensions/models/server.ts'
import { Quota, RETRY_MINUTES, spent } from '../extensions/models/quota.ts'
import { SwitchbackDoc } from '../extensions/models/switchback.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import watchdog from '../extensions/watchdog/server.ts'
import { Metadata } from '../server/metadata.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { temp } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  vi.restoreAllMocks()
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

/** What a conversation's agent definition runs on, as the subagents extension reports it. */
type Runs = { family?: string; model?: { provider: string; modelId: string } }

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
    definition?: Runs | ((id: ConversationId) => Runs | undefined)
    /** The project settings' `modelFamilies`. */
    families?: unknown
    /** The rest of the project settings, beside `modelFamilies`. */
    project?: Record<string, unknown>
    /** `faux2` also serves the conversation's own model id, so the chain's `same` step resolves there. */
    sameId?: boolean
  } = {},
) {
  let now = 1_000_000
  // The refused provider's mark is read off the wall clock, as it is in the server, so the suite owns one clock.
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const registry = createRegistry()
  const runtime = createModels()
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] })
  const alt = fauxProvider({
    provider: 'faux2',
    models: options.sameId ? [{ id: 'faux-2' }, { id: 'faux-1' }] : [{ id: 'faux-2' }],
  })
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
  const openSettings = { models: runtime, registry, now: () => now, settings }
  let harness = await Harness.open(storage, openSettings, context)
  // The providers with a login here, as the snapshot reports them; a marked provider is the only other reason to move.
  // A test can log one in or out while it runs, as a login flow or a refresh does on a live server.
  const signedIn = new Set(options.signedIn ?? ['faux', 'faux2', 'faux3'])
  const available = () =>
    [
      { provider: 'faux', id: 'faux-1' },
      { provider: 'faux2', id: 'faux-2' },
      ...(options.sameId ? [{ provider: 'faux2', id: 'faux-1' }] : []),
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
      getAvailableSnapshot: () => available(),
      getProvider: (provider: string) => runtime.getProvider(provider),
      isUsingSubscription: (provider: string) => subscriptions.has(provider),
      checkAuth: async (provider: string) =>
        available().some((entry) => entry.provider === provider) ? { type: 'api_key' } : undefined,
      getModel: (provider: string, id: string) => runtime.getModel(provider, id),
    },
    settings: {
      getDefaultProvider: () => configured.provider,
      getDefaultModel: () => configured.modelId,
    },
    // The definition a conversation runs as, when a test gives it one: the model it runs on, else its family's
    // fallback, is what takes over. One definition for every conversation, or one per conversation.
    want: (api: { name: string }) => {
      const definition = options.definition
      if (api.name !== 'models.definition' || !definition) return undefined
      return {
        runs: async (_tx: unknown, id: ConversationId) =>
          typeof definition === 'function' ? definition(id) : definition,
      }
    },
    projectSettings: async () => ({
      ...options.project,
      ...(options.families === undefined ? {} : { modelFamilies: options.families }),
    }),
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
    /** The one clock every mark, entry and deadline here reads. */
    clock: () => now,
    /** Move the clock past a moment without waking anything: a reset that has come. */
    advance: (ms: number) => {
      now += ms
    },
    /** Close and reopen the harness on the same storage: documents survive a restart, listeners and memory do not. */
    restart: async () => {
      await harness.close(context)
      harness = await Harness.open(storage, openSettings, context)
    },
    /** The move back a review conversation still owes, and where it comes from. */
    switchback: async (id: ConversationId) =>
      (await harness.snapshot(SwitchbackDoc, id, context))?.pending,
    /** Log a provider in or out for the availability snapshot and `checkAuth` alike. */
    signIn: (provider: string, signed = true) => {
      if (signed) signedIn.add(provider)
      else signedIn.delete(provider)
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

it('walks a family fallback list one step per failure, through the watchdog', async () => {
  // Two entries on two providers, and a configured default that has no login here, so only the family's own steps can
  // move it: the first entry takes the watchdog's continuation, and its own failure leaves the second entry for the
  // next input. The watchdog grants one continuation per failed run, so the second move is where a conversation with
  // two spent providers really goes next.
  const f = await fixture(
    { primary: () => error(quota), fallback: () => error(quota) },
    {
      definition: { family: 'fast', model },
      families: {
        families: { fast: { model: 'faux/faux-1', fallback: ['faux2/faux-2', 'faux3/faux-3'] } },
      },
      configured: { provider: 'faux9', modelId: 'gone' },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  // The first entry, not the second one and not the default: the continuation finishes on faux2.
  await until(async () => f.asked.faux2.length === 1)
  expect(f.asked.faux2[0]).toContain('Continue from where you left off')
  expect(f.asked.faux3).toEqual([])
  expect(await f.agent(branch)).toMatchObject({ model: other })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  // The first entry refuses in turn: that run is lost, and the watchdog reports it instead of a third attempt.
  await until(async () => (await f.marks()).faux2 !== undefined)
  await until(async () => (await f.entries(f.ultimate, 'watchdog.failure')).length === 1)
  expect(await f.agent(branch)).toMatchObject({ model: other })
  // The next input walks on to the second entry: the provider it marked spent is skipped, not tried again.
  await (await f.submit(branch, 'and again')).wait(context)
  expect(await f.agent(branch)).toMatchObject({ model: { provider: 'faux3', modelId: 'faux-3' } })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
    { from: 'faux2/faux-2', to: 'faux3/faux-3', reason: 'quota' },
  ])
  const answer = (await f.entries(branch)).findLast((entry) => entry.kind === 'pi.assistant')
  expect(answer?.model?.[0]).toMatchObject({ provider: 'faux3', model: 'faux-3' })
})

it('skips a family fallback entry without a login here', async () => {
  // faux2 is logged out, so the first entry cannot take over and the second one does; the chain is every entry in
  // order, each one checked, not the list's first name.
  const f = await fixture(
    { primary: () => error(quota) },
    {
      signedIn: ['faux', 'faux3'],
      definition: { family: 'fast', model },
      families: {
        families: { fast: { model: 'faux/faux-1', fallback: ['faux2/faux-2', 'faux3/faux-3'] } },
      },
      configured: { provider: 'faux9', modelId: 'gone' },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux3.length === 1)
  expect(f.asked.faux2).toEqual([])
  expect(await f.agent(branch)).toMatchObject({ model: { provider: 'faux3', modelId: 'faux-3' } })
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux3/faux-3', reason: 'quota' },
  ])
})

it('lets a later family fallback entry cross from a subscription, and says the provider is billed', async () => {
  // The list's second entry is the owner saying where to spend, so it may cross even though the first entry was no
  // crossing at all: the rule holds per step, not for the list's first member.
  const f = await fixture(
    { primary: () => error(quota), fallback: () => error(quota) },
    {
      subscriptions: ['faux', 'faux2'],
      definition: { family: 'fast', model },
      families: {
        families: { fast: { model: 'faux/faux-1', fallback: ['faux2/faux-2', 'faux3/faux-3'] } },
      },
      configured: { provider: 'faux9', modelId: 'gone' },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  // Another subscription login: no crossing, so the entry carries no `billed`.
  await until(async () => f.asked.faux2.length === 1)
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  await until(async () => (await f.marks()).faux2 !== undefined)
  await until(async () => (await f.entries(f.ultimate, 'watchdog.failure')).length === 1)
  // The second entry is billed per token: a written-down fallback step may cross, and the entry says so.
  await (await f.submit(branch, 'and again')).wait(context)
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
    { from: 'faux2/faux-2', to: 'faux3/faux-3', reason: 'quota', billed: true },
  ])
  expect(fallbacks(await f.entries(branch))[1].model?.[0]?.content).toBe(
    'faux2/faux-2 is out of quota here; this conversation now runs on faux3/faux-3, billed per token.',
  )
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

it("moves a subscription conversation to the family's billed fallback, and says the provider is billed", async () => {
  // The user's own case: an everyday model on a subscription login, and the family's fallback on a pay-per-token one
  // for when it runs out. The fallback is written down, so the move is no silent switch, and the entry says so.
  const f = await fixture(
    { primary: () => error(quota) },
    {
      subscriptions: ['faux'],
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
  // The watchdog's continuation runs on the fallback, and the work finishes there.
  expect(await f.agent(branch)).toMatchObject({ model: other })
  expect(f.asked.faux3).toEqual([])
  const answer = (await f.entries(branch)).findLast((entry) => entry.kind === 'pi.assistant')
  expect(answer?.model?.[0]).toMatchObject({ provider: 'faux2', model: 'faux-2' })
  // The entry names the model it moved to and that the login it crossed into is billed per token.
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota', billed: true },
  ])
  expect(fallbacks(await f.entries(branch))[0].model?.[0]?.content).toBe(
    'faux/faux-1 is out of quota here; this conversation now runs on faux2/faux-2, billed per token.',
  )

  // The other trigger, same rule and same sentence: the subscription's login is gone, not its quota.
  const gone = await fixture(
    { primary: () => fauxAssistantMessage('the answer') },
    {
      signedIn: ['faux2'],
      subscriptions: ['faux'],
      definition: { family: 'fast', model },
      families: { families: { fast: { model: 'faux/faux-1', fallback: 'faux2/faux-2' } } },
      configured: { provider: 'faux3', modelId: 'faux-3' },
    },
  )
  const loginless = await gone.conversation('Implement the task')
  await (await gone.submit(loginless, 'do it')).wait(context)
  await until(async () => (await gone.entries(loginless, 'models.fallback')).length === 1)
  expect(await gone.agent(loginless)).toMatchObject({ model: other })
  expect(fallbacks(await gone.entries(loginless)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'family', billed: true },
  ])
  expect(fallbacks(await gone.entries(loginless))[0].model?.[0]?.content).toBe(
    'Model faux/faux-1 has no login here; this conversation now runs on faux2/faux-2, billed per token.',
  )
})

it('lets only the family step cross from a subscription to a billed login', async () => {
  // Every other step of the chain would reach a pay-per-token login that has one: `same` (faux2 also serves faux-1),
  // the definition's pin and the configured default. Only the family's written-down fallback may cross, so it is the
  // one that moves.
  const setup = {
    subscriptions: ['faux'],
    sameId: true,
    definition: { family: 'fast', model: { provider: 'faux2', modelId: 'faux-2' } },
    configured: { provider: 'faux2', modelId: 'faux-2' },
  }
  const f = await fixture(
    { primary: () => error(quota) },
    {
      ...setup,
      families: {
        families: {
          fast: { fallback: 'faux3/faux-3' },
          default: { model: 'faux2/faux-2' },
        },
      },
    },
  )
  const branch = await f.conversation('Implement the task')
  await (await f.submit(branch, 'do it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux3.length === 1)
  expect(await f.agent(branch)).toMatchObject({ model: { provider: 'faux3', modelId: 'faux-3' } })
  expect(f.asked.faux2).toEqual([])
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux3/faux-3', reason: 'quota', billed: true },
  ])

  // Without a family fallback nobody asked for the spend, so nothing crosses and the entry asks the user.
  const guard = await fixture(
    { primary: () => error(quota) },
    { ...setup, families: { families: { default: { model: 'faux2/faux-2' } } } },
  )
  const kept = await guard.conversation('Implement the task')
  await (await guard.submit(kept, 'do it')).wait(context)
  await until(async () => (await guard.marks()).faux !== undefined)
  await guard.deadline()
  await until(async () => (await guard.entries(kept, 'models.fallback')).length === 1)
  expect(await guard.agent(kept)).toMatchObject({ model })
  expect(guard.asked.faux2).toEqual([])
  expect(guard.asked.faux3).toEqual([])
  expect(fallbacks(await guard.entries(kept)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', reason: 'quota' },
  ])
})

it('moves a subscription to a subscription family fallback without mentioning billing', async () => {
  const f = await fixture(
    { primary: () => error(quota) },
    {
      subscriptions: ['faux', 'faux2'],
      definition: { family: 'fast' },
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
  // No crossing at all, so the entry carries no `billed` and the wording stays the one it always had.
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
  expect(fallbacks(await f.entries(branch))[0].model?.[0]?.content).toBe(
    'faux/faux-1 is out of quota here; this conversation now runs on faux2/faux-2.',
  )
})

it('leaves a provider alone until its cooldown runs out, then lets it be chosen again', () => {
  const marks = { providers: { faux: { at: 1_000, until: 2_000 } } }
  expect(spent(marks, 'faux', 1_500)).toBe(true)
  expect(spent(marks, 'faux', 2_000)).toBe(false)
  expect(spent(marks, 'faux2', 1_500)).toBe(false)
  expect(spent({ providers: {} }, 'faux', 1_500)).toBe(false)
})

const day = 86_400_000
/** What a refusal names when it names a moment: three days from now. */
const named = "You've hit your usage limit. Upgrade to Plus or try again in 3 days."

/** This machine's families: `review` on a subscription login, with the paid fallback it names. */
const reviewFamilies = { families: { review: { model: 'faux/faux-1', fallback: 'faux2/faux-2' } } }
/** What a reviewer conversation is: on the review family, whose model is a subscription login and whose fallback is not. */
const reviewRun = (families: unknown = reviewFamilies) => ({
  subscriptions: ['faux'],
  definition: { family: 'review', model },
  families,
  configured: { provider: 'faux3', modelId: 'faux-3' },
})

it('reads the moment a refusal names, and no moment out of a refusal that names none', () => {
  const now = Date.parse('2026-11-05T09:00:00Z')
  // A duration after the words providers use, Pi's own sentence when Codex's body carries `resets_at` included.
  expect(resetAt(named, now)).toBe(now + 3 * day)
  expect(
    resetAt('You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.', now),
  ).toBe(now + 42 * 60_000)
  expect(resetAt('429 Too Many Requests. Retry after 1200 seconds.', now)).toBe(now + 1_200_000)
  expect(resetAt('{"error":{"code":"rate_limit","resets_in_seconds": 600}}', now)).toBe(
    now + 600_000,
  )
  // HTTP's own header, quoted or not, is seconds.
  expect(resetAt('{"retry-after": "1200"}', now)).toBe(now + 1_200_000)
  // A timestamp.
  expect(resetAt('Rate limit resets at 2026-11-05T12:30:00Z', now)).toBe(
    Date.parse('2026-11-05T12:30:00Z'),
  )
  // What this machine actually gets from Codex, and the other refusals that name nothing.
  for (const text of [
    'Codex error: The usage limit has been reached',
    quota,
    'Insufficient Balance',
    "This request would exceed your account's rate limit. Please try again later.",
  ])
    expect(resetAt(text, now)).toBeUndefined()
  // A moment already past, or further out than any quota window, is no moment at all.
  expect(resetAt('The limit resets at 2026-11-05T08:00:00Z', now)).toBeUndefined()
  expect(resetAt('You can try again in 12 weeks', now)).toBeUndefined()
  // A body's own timestamp is not a reset: only the words of one introduce a moment.
  expect(
    resetAt(
      'Request 2026-11-05T09:00:01Z failed: insufficient_quota (created_at 2026-11-05T09:00:00Z)',
      now,
    ),
  ).toBeUndefined()
})

it('records the reset a refusal names and runs the review on its paid fallback until then', async () => {
  const f = await fixture({ primary: () => error(named) }, reviewRun())
  const review = await f.conversation('Review the range')
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  const moment = f.clock() + 3 * day
  expect(await f.marks()).toEqual({ faux: { at: f.clock(), until: moment } }) // The watchdog continues the refused run: it starts on the fallback the family names, which is billed per token.
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  expect(await f.agent(review)).toMatchObject({ model: other })
  const [moved] = fallbacks(await f.entries(review))
  expect(moved.data).toEqual({
    from: 'faux/faux-1',
    to: 'faux2/faux-2',
    reason: 'quota',
    billed: true,
    until: moment,
  })
  expect(moved.model?.[0]?.content).toBe(
    'faux/faux-1 is out of quota here; this conversation now runs on faux2/faux-2, billed per token. It goes back to faux/faux-1 once the limit resets.',
  )
  // The move it owes back is written down on the conversation, naming the family the rule applies to.
  expect(await f.switchback(review)).toEqual({
    family: 'review',
    from: 'faux/faux-1',
    to: 'faux2/faux-2',
  })
})

/** A refusal first, then the answer the same provider gives once its limit is back. */
const refuseOnce = (answer: string) => {
  let refused = false
  return () => {
    if (refused) return fauxAssistantMessage(answer)
    refused = true
    return error(named)
  }
}

it('runs the next input on the model its family names once the recorded moment has come', async () => {
  const f = await fixture({ primary: refuseOnce('the review') }, reviewRun())
  const review = await f.conversation('Review the range')
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  // Before the moment nothing changes and nothing is tried: the conversation stays where the fallback put it.
  await (await f.submit(review, 'and again')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model: other })
  expect(f.asked.faux).toHaveLength(1)
  // At the moment the next input goes back to that model by itself, and the entry says so.
  f.advance(3 * day)
  await (await f.submit(review, 'one more')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model })
  expect(f.asked.faux).toHaveLength(2)
  const returned = fallbacks(await f.entries(review)).at(-1)!
  expect(returned.data).toEqual({ from: 'faux2/faux-2', to: 'faux/faux-1', reason: 'reset' })
  expect(returned.model?.[0]?.content).toBe(
    'faux/faux-1 has quota again; this conversation runs back on it.',
  )
  expect(await f.switchback(review)).toBeUndefined()
  // The answer came from the family's model, not from the fallback.
  const answer = (await f.entries(review)).findLast((entry) => entry.kind === 'pi.assistant')
  expect(answer?.model?.[0]).toMatchObject({ provider: 'faux', model: 'faux-1' })
})

it('keeps the pending move back across a restart', async () => {
  const f = await fixture({ primary: refuseOnce('the review') }, reviewRun())
  const review = await f.conversation('Review the range')
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  const mark = (await f.marks()).faux
  await f.restart()
  // Both the mark and the move it owes are documents: the new process reads the same moment.
  expect((await f.marks()).faux).toEqual(mark)
  expect(await f.switchback(review)).toEqual({
    family: 'review',
    from: 'faux/faux-1',
    to: 'faux2/faux-2',
  })
  f.advance(3 * day)
  await (await f.submit(review, 'one more')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model })
  expect(fallbacks(await f.entries(review)).at(-1)?.data).toEqual({
    from: 'faux2/faux-2',
    to: 'faux/faux-1',
    reason: 'reset',
  })
})

it('never moves a family other than review back to its model', async () => {
  const f = await fixture(
    { primary: refuseOnce('the work') },
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
  // The fast family writes no move back, and its entry carries no moment either.
  expect(await f.switchback(branch)).toBeUndefined()
  f.advance(3 * day)
  await (await f.submit(branch, 'go on')).wait(context)
  expect(await f.agent(branch)).toMatchObject({ model: other })
  expect(f.asked.faux).toHaveLength(1)
  expect(fallbacks(await f.entries(branch)).map((entry) => entry.data)).toEqual([
    { from: 'faux/faux-1', to: 'faux2/faux-2', reason: 'quota' },
  ])
})

it("lets the user's own re-point of review win over the pending move", async () => {
  const families = structuredClone(reviewFamilies)
  const f = await fixture({ primary: refuseOnce('the review') }, reviewRun(families))
  const review = await f.conversation('Review the range')
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  // The user points review at another model while the move back is pending.
  families.families.review.model = 'faux3/faux-3'
  f.advance(3 * day)
  await (await f.submit(review, 'one more')).wait(context)
  // The conversation keeps the model it runs on: the pending move is dropped, not turned into a different one.
  expect(await f.agent(review)).toMatchObject({ model: other })
  expect(await f.switchback(review)).toBeUndefined()
  expect(f.asked.faux3).toEqual([])
  expect(fallbacks(await f.entries(review))).toHaveLength(1)
})

it('does not take back a model the user picked for the conversation', async () => {
  const f = await fixture({ primary: refuseOnce('the review') }, reviewRun())
  const review = await f.conversation('Review the range')
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  // Another model than the one the fallback moved it to: the user chose it, so the move back is dropped.
  await f.harness.commit(
    (tx) => configure(tx, review, { model: { provider: 'faux3', modelId: 'faux-3' } }),
    context,
  )
  f.advance(3 * day)
  await (await f.submit(review, 'one more')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model: { provider: 'faux3', modelId: 'faux-3' } })
  expect(await f.switchback(review)).toBeUndefined()
  expect(f.asked.faux).toHaveLength(1)
})

it('uses the retry interval when a refusal names no reset, and the project may set its own', async () => {
  const silent = 'Codex error: The usage limit has been reached'
  const f = await fixture({ primary: () => error(silent) }, {})
  const branch = await f.conversation('Write the review')
  await (await f.submit(branch, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  expect((await f.marks()).faux).toEqual({
    at: f.clock(),
    until: f.clock() + RETRY_MINUTES * 60_000,
  })
  const slower = await fixture(
    { primary: () => error(silent) },
    { project: { quotaRetryMinutes: 30 } },
  )
  const patient = await slower.conversation('Write the review')
  await (await slower.submit(patient, 'review it')).wait(context)
  await until(async () => (await slower.marks()).faux !== undefined)
  expect((await slower.marks()).faux?.until).toBe(slower.clock() + 30 * 60_000)
})

it('keeps a pending review switch apart from another family refused on another provider', async () => {
  // The seam the next branch's free chain meets: a refusal that is not review's must not move, clear or re-time the
  // move review owes, and review must still go back at its own moment.
  const runs: Record<number, { family?: string; model?: typeof model } | undefined> = {}
  const f = await fixture(
    { primary: refuseOnce('the review'), third: () => error(named) },
    {
      subscriptions: ['faux'],
      definition: (id) => runs[id],
      families: {
        families: {
          review: { model: 'faux/faux-1', fallback: 'faux2/faux-2' },
          tiny: { model: 'faux3/faux-3', fallback: 'faux2/faux-2' },
        },
      },
      configured: { provider: 'faux2', modelId: 'faux-2' },
    },
  )
  const review = await f.conversation('Review the range')
  runs[review] = { family: 'review', model }
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  const reviewMark = (await f.marks()).faux
  // Another family, on another provider, refuses for a spent account and walks to its own fallback.
  const small = await f.conversation('Small job')
  runs[small] = { family: 'tiny', model: { provider: 'faux3', modelId: 'faux-3' } }
  await f.harness.commit(
    (tx) => configure(tx, small, { model: { provider: 'faux3', modelId: 'faux-3' } }),
    context,
  )
  await (await f.submit(small, 'do the small thing')).wait(context)
  await until(async () => (await f.marks()).faux3 !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 2)
  expect(await f.agent(small)).toMatchObject({ model: other })
  expect(fallbacks(await f.entries(small)).map((entry) => entry.data)).toEqual([
    { from: 'faux3/faux-3', to: 'faux2/faux-2', reason: 'quota' },
  ])
  // Nothing of review's changed: not its mark, not the move it owes, and the other family owes none.
  expect((await f.marks()).faux).toEqual(reviewMark)
  expect(await f.switchback(review)).toEqual({
    family: 'review',
    from: 'faux/faux-1',
    to: 'faux2/faux-2',
  })
  expect(await f.switchback(small)).toBeUndefined()
  // And review still goes back at its own moment.
  f.advance(3 * day)
  await (await f.submit(review, 'one more')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model })
  expect(fallbacks(await f.entries(review)).at(-1)?.data).toEqual({
    from: 'faux2/faux-2',
    to: 'faux/faux-1',
    reason: 'reset',
  })
})

it('keeps the move back while the provider looks logged out, and takes it when the login is back', async () => {
  const f = await fixture({ primary: refuseOnce('the review') }, reviewRun())
  const review = await f.conversation('Review the range')
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  await until(async () => f.asked.faux2.length === 1)
  // A snapshot without the login is no evidence that it is gone, so the move waits instead of being thrown away.
  f.signIn('faux', false)
  f.advance(3 * day)
  await (await f.submit(review, 'one more')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model: other })
  expect(await f.switchback(review)).toEqual({
    family: 'review',
    from: 'faux/faux-1',
    to: 'faux2/faux-2',
  })
  expect(fallbacks(await f.entries(review))).toHaveLength(1)
  // The login comes back: the next input goes back once more, as if nothing had happened.
  f.signIn('faux')
  await (await f.submit(review, 'and again')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model })
  expect(fallbacks(await f.entries(review)).at(-1)?.data).toEqual({
    from: 'faux2/faux-2',
    to: 'faux/faux-1',
    reason: 'reset',
  })
})

it('goes back to the model its family names from a later step of an ordered fallback', async () => {
  // Two spent providers, so the move takes the second entry: the move back still names the family's own model, not the
  // intermediate one the conversation leaves the second time.
  const runs: Record<number, Runs | undefined> = {}
  const f = await fixture(
    { primary: refuseOnce('the review'), fallback: refuseOnce('the middle step') },
    {
      subscriptions: ['faux'],
      definition: (id) => runs[id],
      families: {
        families: { review: { model: 'faux/faux-1', fallback: ['faux2/faux-2', 'faux3/faux-3'] } },
      },
      configured: { provider: 'faux9', modelId: 'gone' },
    },
  )
  const review = await f.conversation('Review the range')
  runs[review] = { family: 'review', model }
  await (await f.submit(review, 'review it')).wait(context)
  await until(async () => (await f.marks()).faux !== undefined)
  await f.deadline()
  // The continuation on the first entry refuses too, which marks it and reports the lost run: the watchdog continues a
  // failed run once, so the next input is what walks on to the second entry.
  await until(async () => (await f.marks()).faux2 !== undefined)
  await (await f.submit(review, 'and again')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model: { provider: 'faux3', modelId: 'faux-3' } })
  // The second step's line promises the family's model, and the move it writes down says the same.
  const [, second] = fallbacks(await f.entries(review))
  expect(second.model?.[0]?.content).toBe(
    'faux2/faux-2 is out of quota here; this conversation now runs on faux3/faux-3. It goes back to faux/faux-1 once the limit resets.',
  )
  expect(await f.switchback(review)).toEqual({
    family: 'review',
    from: 'faux/faux-1',
    to: 'faux3/faux-3',
  })
  f.advance(3 * day)
  await (await f.submit(review, 'one more')).wait(context)
  expect(await f.agent(review)).toMatchObject({ model })
  expect(fallbacks(await f.entries(review)).at(-1)?.data).toEqual({
    from: 'faux3/faux-3',
    to: 'faux/faux-1',
    reason: 'reset',
  })
})
