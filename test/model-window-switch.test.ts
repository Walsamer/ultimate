import { join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterAll, expect, it } from 'vitest'
import { fauxServer, post, temp } from './helpers.ts'
import { context } from '../server/harness.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** What the hub models are declared with on this machine: a conversation holds it only up to a threshold. */
const narrow = 131_072
const wide = 1_000_000

/**
 * One server whose provider offers a wide window and a narrow one, shared by the tests, each on its own conversation.
 * The boot is paid inside the first test that needs it rather than by a hook with a budget of its own.
 */
let booted: Promise<Server> | undefined
function boot() {
  return (booted ??= launch())
}
async function launch() {
  const home = await temp('ultimate-window-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const started = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
    faux: fauxProvider({
      models: [
        { id: 'wide', contextWindow: wide },
        { id: 'narrow', contextWindow: narrow },
      ],
    }),
  })
  servers.push(started)
  return started
}

/** A conversation of its own, so a switch here cannot be another test's. */
async function fresh(server: Server) {
  return (await post(server, '/api/conversations', {})).data.id as number
}

/**
 * A conversation of eight exchanges, each side 35,000 characters: about 140,000 tokens by Pi's own estimate, so above
 * the narrow window's blocking threshold and below the wide one. Written as entries rather than run, because what the
 * guard measures is the conversation's shape, not how it got there.
 */
async function grow(server: Server, id: number) {
  const text = (mark: string) => `${mark} `.padEnd(35_000, mark)
  // What a provider reports for the prompt it was sent: the last request saw the whole of these eight exchanges.
  const usage = (totalTokens: number) => ({
    input: totalTokens,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  })
  await server.harness.commit(async (tx) => {
    for (let turn = 0; turn < 8; turn++) {
      await tx.appendEntry(id as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: text(`u${turn}`), timestamp: Date.now() }],
      })
      await tx.appendEntry(id as ConversationId, {
        kind: 'pi.assistant',
        model: [
          {
            ...fauxAssistantMessage(text(`a${turn}`), { timestamp: Date.now() }),
            usage: usage(turn === 7 ? 125_000 : 1_000),
          },
        ],
      })
    }
  }, context)
}

const configure = (server: Server, id: number, data: Record<string, unknown> = {}) =>
  post(server, `/api/conversations/${id}/configure`, {
    model: { provider: 'faux', modelId: 'narrow' },
    ...data,
  })
const modelOf = async (server: Server, id: number) =>
  (await (await server.harness.conversation(id as ConversationId, context))!.agent(context)).model
    ?.modelId

it('asks before a switch to a model that cannot hold the conversation, and takes the answer', async () => {
  const server = await boot()
  const id = await fresh(server)
  await grow(server, id)

  const asked = await configure(server, id)
  expect(asked.status).toBe(409)
  expect(asked.data.error).toContain('131,072')
  expect(asked.data.error).toContain('condense')
  // Refused means unchanged: the conversation still runs on the model that holds it.
  expect(await modelOf(server, id)).toBe('wide')

  expect((await configure(server, id, { condense: 'anyway' })).status).toBe(200)
  expect(await modelOf(server, id)).toBe('narrow')
})

it('condenses the conversation on the model that holds it, then switches', async () => {
  const server = await boot()
  const id = await fresh(server)
  await grow(server, id)
  // The summary the condensation asks for; a scripted one keeps it short, as a real one is.
  server.host.faux!.setResponses([fauxAssistantMessage('The work so far, in one paragraph.')])

  expect((await configure(server, id, { condense: 'before' })).status).toBe(200)
  expect(await modelOf(server, id)).toBe('narrow')
  const conversation = await server.harness.conversation(id as ConversationId, context)
  const entries = (await conversation!.entries({}, 64, undefined, context)).items
  expect(entries.some((entry) => entry.kind === 'pi.compaction')).toBe(true)
})

it('switches a conversation that fits without asking, and refuses an answer it does not know', async () => {
  const server = await boot()
  const id = await fresh(server)
  expect((await configure(server, id)).status).toBe(200)
  expect(await modelOf(server, id)).toBe('narrow')
  expect((await configure(server, id, { condense: 'later' })).status).toBe(400)
})
