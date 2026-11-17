import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  configure,
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { readFamilies, writeFamilies } from '../lib/families-settings.ts'
import models, { actions } from '../extensions/models/server.ts'
import type { FamilyMove, SaveFamilies } from '../extensions/models/refs.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { Metadata } from '../server/metadata.ts'
import { UiState } from '../server/ui-state.ts'
import { temp } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  vi.restoreAllMocks()
})

/** The conversation's agent definition, as the subagents extension reports it. */
type Runs = { family?: string; model?: { provider: string; modelId: string } }
const old = { provider: 'faux', modelId: 'faux-1' }
const next = { provider: 'faux', modelId: 'faux-2' }
const ref = (model: { provider: string; modelId: string }) => `${model.provider}/${model.modelId}`

/**
 * A harness running the real models backend: two models of one provider, the families a save posts, and one definition
 * per conversation as a test gives it. The root is @ultimate and follows Pi's default model, `faux/faux-1`, until the
 * save gives the default family a model of its own.
 */
async function fixture() {
  const registry = createRegistry()
  const runtime = createModels()
  const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  runtime.setProvider(faux.provider)
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const now = 1_000_000
  const harness = await Harness.open(
    storage,
    { models: runtime, registry, now: () => now, settings: { retry: { maxRetries: 0 } } },
    context,
  )
  const home = await temp('ultimate-family-moves-')
  // The families as they are before a save: the user's `worker` and `other`, both on the model conversations run on.
  await writeFamilies(home, home, {
    families: { worker: { model: ref(old) }, other: { model: ref(old) } },
  })
  const definitions = new Map<ConversationId, Runs>()
  const concluded: number[] = []
  const notices: string[] = []
  const resources = new Map<string, unknown>()
  const host = {
    harness: () => harness,
    modelRuntime: runtime,
    settings: {
      getDefaultProvider: () => old.provider,
      getDefaultModel: () => old.modelId,
      getDefaultThinkingLevel: () => 'medium',
    },
    // The definition a conversation runs as: one per conversation, or none (the default family).
    want: (api: { name: string }) =>
      api.name === 'models.definition'
        ? { runs: async (_tx: unknown, id: ConversationId) => definitions.get(id) }
        : undefined,
    projectSettings: async () => ({
      // A team overlay decides `other`'s model itself, and adds a field without replacing another's model.
      modelFamilies: { families: { other: { model: ref(old), thinking: 'high' } } },
    }),
    uiState: async (caller: Context) =>
      (await harness.snapshot(UiState, ROOT_CONVERSATION_ID, caller)) ?? {},
    notice: (text: string) => notices.push(text),
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: () => {},
    onClose: () => {},
    onRelease: () => {},
    metadata: Metadata,
    userHome: home,
    projectRoot: home,
  } as unknown as ExtensionHost
  registry.install(models(host))
  const { id: root } = await harness.root(context, { agent: { model: old } })
  cleanups.push(async () => {
    await harness.close(context)
  })
  /** A conversation running on `model`, with a title and (when a test gives it one) a definition. */
  const conversation = async (
    title: string,
    options: { model?: typeof old; runs?: Runs; concluded?: boolean } = {},
  ) => {
    const model = options.model ?? old
    const id = await harness.commit(async (tx) => {
      const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, created.id, { model })
      Object.assign(await tx.doc(Metadata, created.id), { title })
      return created.id
    }, context)
    if (options.runs) definitions.set(id, options.runs)
    if (options.concluded)
      await harness.commit(async (tx) => {
        concluded.push(id)
        ;(await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded'] = concluded
      }, context)
    return id
  }
  const entries = async (id: ConversationId, kind: string): Promise<EntryRecord[]> =>
    (
      await harness.commit(
        (tx) => tx.scanEntries({ conversationId: id, order: 'ascending' }, 500),
        context,
      )
    ).items.filter((entry) => entry.kind === kind)
  const agent = async (id: ConversationId) =>
    (await harness.conversation(id, context))!.agent(context)
  const call = { host } as ActionContext
  return {
    host,
    harness,
    home,
    root,
    conversation,
    entries,
    agent,
    definitions,
    notices,
    /** The open conversations this save would move; it changes nothing. */
    preview: (args: SaveFamilies) => actions.previewFamilies(args, call),
    /** The save alone: families, no conversation. */
    save: (args: unknown) => actions.saveFamilies(args as never, call),
    /** The one root notice for a batch of moves. */
    report: (requestId: string, moves: FamilyMove[]) =>
      actions.reportFamilyMoves({ requestId, moves }, call),
    /** `configure` each conversation as the UI does after the user accepts, then say so. */
    configure: (id: ConversationId, model: typeof old) =>
      harness.commit((tx) => configure(tx, id, { model }), context),
    /** The families file this project now keeps. */
    saved: async () => (await readFamilies(home, home, {})).families,
  }
}

/** The save a test posts: the whole families map as the editor holds it, and no assignment or pin changes. */
const args = (families: SaveFamilies['families']): SaveFamilies => ({
  families,
  assign: {},
  unpin: [],
})
const familiesAfter = args({
  default: { color: 'sky', model: ref(next) },
  worker: { color: 'amber', model: ref(next) },
  // The project overlay keeps this family on the old model, so the save changes nothing for it.
  other: { color: 'teal', model: ref(next) },
})

it('previews the open conversations a family change would move, naming only the ones it touches', async () => {
  const f = await fixture()
  const first = await f.conversation('Branch one', { runs: { family: 'worker' } })
  // No definition: the default family, which this save gives a model of its own instead of Pi's default.
  const second = await f.conversation('Branch two')
  const gone = await f.conversation('Concluded branch', {
    runs: { family: 'worker' },
    concluded: true,
  })
  // A definition that pins a model keeps it, whatever its family names.
  await f.conversation('Pinned branch', { runs: { model: old } })
  // A family that shares the old model without changing keeps its conversations where they are.
  await f.conversation('Other family', { runs: { family: 'other' } })
  // Already on the new model: nothing to move.
  await f.conversation('Moved already', { model: next, runs: { family: 'worker' } })
  const moves = await f.preview(familiesAfter)
  expect(moves).toEqual([
    { id: first, title: 'Branch one', family: 'worker', from: ref(old), to: ref(next) },
    { id: second, title: 'Branch two', family: 'default', from: ref(old), to: ref(next) },
  ])
  // @ultimate runs on the default family too, and is never moved; the concluded one stays concluded.
  expect(moves.map((move) => move.id)).not.toContain(f.root)
  expect(moves.map((move) => move.id)).not.toContain(gone)
  // Previewing wrote nothing: no agent changed, and the families are as they were.
  expect(await f.agent(first)).toMatchObject({ model: old })
  expect((await f.saved()).worker?.model).toBe(ref(old))
})

it('saves the families alone, leaving every open conversation on its model', async () => {
  const f = await fixture()
  const first = await f.conversation('Branch one', { runs: { family: 'worker' } })
  const second = await f.conversation('Branch two')
  await f.save(familiesAfter)
  // The families are saved; the conversations keep what they run on, and the same save now finds nothing to move.
  expect((await f.saved()).worker?.model).toBe(ref(next))
  expect(await f.agent(first)).toMatchObject({ model: old })
  expect(await f.agent(second)).toMatchObject({ model: old })
  expect(await f.preview(familiesAfter)).toEqual([])
})

it('reports the moved conversations once on the root, naming each of them', async () => {
  const f = await fixture()
  const first = await f.conversation('Branch one', { runs: { family: 'worker' } })
  const second = await f.conversation('Branch two')
  const moves: FamilyMove[] = [
    { id: first, title: 'Branch one', family: 'worker', from: ref(old), to: ref(next) },
    { id: second, title: 'Branch two', family: 'default', from: ref(old), to: ref(next) },
  ]
  // What the UI does once the user accepts: save, configure each conversation, then report what moved.
  await f.save(familiesAfter)
  await f.configure(first, next)
  await f.configure(second, next)
  await f.report('moves-1', moves)
  const written = await f.entries(f.root, 'models.family-moved')
  expect(written).toHaveLength(1)
  expect(written[0].data).toEqual({ moves })
  const words = written[0]
    .model!.flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n')
  expect(words).toContain(`#${first} Branch one`)
  expect(words).toContain(`#${second} Branch two`)
  expect(words).toContain(`${ref(old)} → ${ref(next)}`)
  // The same report again writes nothing: the request id settles it.
  await f.report('moves-1', moves)
  expect(await f.entries(f.root, 'models.family-moved')).toHaveLength(1)
  // A claim the conversations do not bear out is refused, so the notice never names a move that did not happen.
  await expect(f.report('moves-2', [{ ...moves[0], to: 'faux/faux-9' }])).rejects.toThrow(
    `#${first} does not run on faux/faux-9`,
  )
  expect(await f.entries(f.root, 'models.family-moved')).toHaveLength(1)
})

it('previews a removed family as moving to the default family model', async () => {
  const f = await fixture()
  const workerBranch = await f.conversation('Worker branch', { runs: { family: 'worker' } })
  // `worker` is gone from the save; its definitions fall back to the default family, which this save moves.
  const removed = await f.preview(
    args({
      default: { color: 'sky', model: ref(next) },
      other: { color: 'teal', model: ref(old) },
    }),
  )
  expect(removed).toEqual([
    { id: workerBranch, title: 'Worker branch', family: 'worker', from: ref(old), to: ref(next) },
  ])
})

it('refuses a fallback that names no target or a model the runtime does not know, naming family and entry', async () => {
  const f = await fixture()
  const withFallback = (fallback: unknown) =>
    args({ worker: { color: 'amber', model: ref(next), fallback: fallback as string | string[] } })
  await expect(f.save(withFallback([{}]))).rejects.toThrow(
    'modelFamilies.families.worker.fallback[0] needs a target',
  )
  await expect(f.save(withFallback('faux/nope'))).rejects.toThrow(
    'modelFamilies.families.worker.fallback: faux/nope is not a model this runtime knows',
  )
  await expect(f.save(withFallback([ref(old), 'faux/nope']))).rejects.toThrow(
    'modelFamilies.families.worker.fallback[1]: faux/nope is not a model this runtime knows',
  )
  // A known model stays: its provider may have no login now, and a login may come back.
  await f.save(withFallback(ref(old)))
  expect((await f.saved()).worker?.fallback).toBe(ref(old))
  expect(f.notices).toEqual([])
})
