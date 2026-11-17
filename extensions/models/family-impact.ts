/**
 * Carrying open conversations along a family change. Saving families applies to conversations started after it, so an
 * open conversation keeps a model the user just replaced — and a provider outage then kills every branch still on it.
 * The UI asks first: `previewFamilies` names what the same save would move, without writing anything, and once the user
 * agrees it saves, configures each conversation through the core route and reports the moves with `reportFamilyMoves`,
 * which writes one passive entry on the project root naming all of them.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, ModelRef } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { DEFAULT_FAMILY, mergeFamilies, parseFamilies, refName, refOf } from '../../lib/families.ts'
import type { Families } from '../../lib/families.ts'
import { readFamilyLayers } from '../../lib/families-settings.ts'
import { Definition } from './api.ts'
import { piDefault, savedFamilies } from './families.ts'
import type { FamilyMove, SaveFamilies } from './refs.ts'

type Change = { family: string; from: string; to: string }
const name = (ref: ModelRef) => refName(ref)

/**
 * The model a family's conversations run on: its own; for the default family, Pi's default model when it names none; and
 * for a family that is gone, the default family's — whose definitions fall back to it.
 */
function effectiveModel(config: Families, family: string, fallback: string | undefined) {
  const spec = config.families[family]
  if (spec?.model) return spec.model
  if (family === DEFAULT_FAMILY) return fallback
  if (!spec) return config.families[DEFAULT_FAMILY]?.model ?? fallback
  return undefined
}

/** The families whose effective model a save changes: its own model or Pi's default, with the project's overlay applied. */
function familyChanges(before: Families, after: Families, fallback: string | undefined) {
  const changes = new Map<string, Change>()
  for (const family of new Set([...Object.keys(before.families), ...Object.keys(after.families)])) {
    const from = effectiveModel(before, family, fallback)
    const to = effectiveModel(after, family, fallback)
    if (from && to && from !== to) changes.set(family, { family, from, to })
  }
  return changes
}

/**
 * The concluded conversations of this project, from the shell's state on the root (as codemode's chapters read them):
 * `ConversationsApi` would be the way, but conversations imports this extension's UI, so `need` would be a cycle.
 */
function concludedIn(ui: Record<string, unknown>) {
  const ids = ui['ext.conversations.concluded']
  return new Set<number>(Array.isArray(ids) ? ids.filter((id) => typeof id === 'number') : [])
}

/**
 * The open conversations a save would move: each unconcluded conversation, other than the project root, that runs on
 * the old model of the family its definition names. A definition that pins a model of its own keeps it, and a
 * conversation with no definition runs on the default family. The family decides, not the model: two families may share
 * a model, and only the one whose model changes moves its conversations.
 */
export async function previewFamilies(
  host: ExtensionHost,
  args: SaveFamilies,
): Promise<FamilyMove[]> {
  const project = await host.projectSettings()
  const layers = await readFamilyLayers(host.userHome, host.projectRoot, project)
  const before = mergeFamilies(layers.base, layers.project)
  const after = mergeFamilies(parseFamilies(savedFamilies(args)), layers.project)
  const pi = piDefault(host).model
  const changes = familyChanges(before, after, pi ? name(pi) : undefined)
  if (!changes.size) return []
  const harness = host.harness()
  const concluded = concludedIn(await host.uiState(context))
  const ids = await harness.commit(async (tx) => {
    const found: ConversationId[] = []
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanConversations({}, 256, cursor)
      found.push(...page.items.map((record) => record.id))
      cursor = page.next
    } while (cursor !== undefined)
    return found
  }, context)
  const candidates = ids.filter((id) => id !== ROOT_CONVERSATION_ID && !concluded.has(id))
  // Read-only throughout: no agent, no document, and no conversation changes before the user answers.
  const models = await Promise.all(
    candidates.map(async (id) => (await harness.snapshot(AgentDoc, id, context))?.model),
  )
  const definition = host.want(Definition)
  const runs = definition
    ? await harness.commit(
        (tx) => Promise.all(candidates.map((id) => definition.runs(tx, id))),
        context,
      )
    : candidates.map(() => undefined)
  const moves: Omit<FamilyMove, 'title'>[] = []
  for (const [index, id] of candidates.entries()) {
    const model = models[index]
    // Its definition's family, or the default family without one; a definition that pins a model is left where it is.
    const family = runs[index] ? runs[index].family : DEFAULT_FAMILY
    const change = family === undefined ? undefined : changes.get(family)
    if (!model || !change || name(model) !== change.from) continue
    moves.push({ id, family: change.family, from: change.from, to: change.to })
  }
  return Promise.all(
    moves.map(async (move) => ({
      ...move,
      title:
        (await harness.snapshot(host.metadata, move.id as ConversationId, context))?.title ??
        'Untitled',
    })),
  )
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** One move as the UI reports it back: an id, a title, a family and two models. */
function readMove(value: unknown): FamilyMove {
  if (!isObject(value)) throw new Error('Expected moves')
  const { id, title, family, from, to } = value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected conversation ids')
  if (typeof title !== 'string') throw new Error(`Expected a title for #${id}`)
  if (typeof family !== 'string' || !family) throw new Error(`Expected a family for #${id}`)
  const before = typeof from === 'string' ? refOf(from) : undefined
  const after = typeof to === 'string' ? refOf(to) : undefined
  if (!before || !after) throw new Error(`Expected "provider/id" models for #${id}`)
  return { id, title, family, from: name(before), to: name(after) }
}

/** What the root's model reads: every moved conversation by id and title, its family, and the models it left and joined. */
function content(moves: FamilyMove[]) {
  const lines = moves.map(
    (move) => `#${move.id} ${move.title} (${move.family}: ${move.from} → ${move.to})`,
  )
  return `Model families: ${moves.length === 1 ? 'one conversation' : `${moves.length} conversations`} moved to the new model:\n${lines.join('\n')}`
}

/**
 * Write the one root notice for a batch of moves: `{ moves }` as the card renders it, and a line the model reads naming
 * every conversation. `requestId` is the conversation-scoped submission id, so a repeated report writes nothing again.
 * Each conversation is checked to run on the model it was moved to, so the notice never claims a move that did not
 * happen (a configure the user's answer raced, or a conversation re-pointed meanwhile).
 */
export async function reportFamilyMoves(
  host: ExtensionHost,
  args: { requestId: string; moves: FamilyMove[] },
): Promise<null> {
  if (!args.requestId) throw new Error('Expected requestId')
  if (!args.moves.length) throw new Error('Expected moves')
  const moves = args.moves.map(readMove)
  const harness = host.harness()
  for (const move of moves) {
    const agent = await harness.snapshot(AgentDoc, move.id as ConversationId, context)
    if (!agent || !agent.model || name(agent.model) !== move.to)
      throw new Error(`#${move.id} does not run on ${move.to}`)
  }
  const root = (await harness.conversation(ROOT_CONVERSATION_ID, context))!
  await root.submit(
    {
      type: 'write',
      requestId: `models.family-moved:${args.requestId}`,
      entry: {
        kind: 'models.family-moved',
        data: { moves },
        model: [{ role: 'user', content: content(moves), timestamp: Date.now() }],
      },
    },
    context,
  )
  return null
}
