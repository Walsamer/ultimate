import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { apportion, format, homeFor, homes, read, report, resolveHome } from '../scripts/cost.ts'

const created: string[] = []
afterEach(async () => {
  for (const folder of created.splice(0)) await rm(folder, { recursive: true, force: true })
})

const T = Date.parse('2026-11-04T12:00:00Z')

/** An assistant entry as the transcript stores it: one model request with its own usage and cost. */
const request = (id: number, conversation: number, cost: number, prompt = 1000, cacheRead = 900) =>
  JSON.stringify({
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [],
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: {
          input: prompt - cacheRead,
          output: 10,
          cacheRead,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: prompt + 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
        durationMs: 1200,
        stopReason: 'toolUse',
        timestamp: T,
      },
    ],
    id,
    conversationId: conversation,
  })

/** An extension event, as the event feed records it: the payload wrapped in `{v, at, data, context}`. */
const event = (id: number, kind: string, payload: unknown, context: unknown = {}) =>
  JSON.stringify({
    kind,
    data: { v: 1, at: new Date(T).toISOString(), data: payload, context },
    id,
    conversationId: 1,
  })

const schema = `
  create table conversations (id integer primary key, record text not null);
  create table entries (id integer primary key, conversation_id integer not null, record text not null);
  create table documents (id integer primary key, kind text not null, owner_id integer not null);
  create table document_revisions (document_id integer not null, seq integer not null, content text not null);`

interface Row {
  id: number
  conversation: number
  record: string
}

/**
 * A home holding one landed work order (#100) with a reviewer and a worker, one that did not land (#200), a standing
 * agent (#300) that dispatched both, and its own subagent (#301). Each test gets its own fake machine under `root`.
 */
async function machine(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-cost-'))
  created.push(root)
  return root
}

async function home(root: string, folder: string, name = 'demo'): Promise<string> {
  const path = join(root, '.ultimate', 'projects', folder)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'project.json'), JSON.stringify({ root: `/tmp/${folder}`, name }))
  const db = new DatabaseSync(join(path, 'state.sqlite'))
  for (const statement of schema.split(';').filter((one) => one.trim())) db.exec(statement)

  const conversations: [number, number | undefined][] = [
    [1, undefined],
    [100, 1],
    [101, 100],
    [102, 100],
    [200, 1],
    [300, undefined],
    [301, 300],
  ]
  const addConversation = db.prepare('insert into conversations (id, record) values (?, ?)')
  for (const [id, parent] of conversations)
    addConversation.run(
      id,
      JSON.stringify(parent === undefined ? { id } : { id, parent: { conversationId: parent } }),
    )

  const rows: Row[] = [
    // #100: two requests of its own, its reviewer's one and its worker's one.
    { id: 10, conversation: 100, record: request(10, 100, 0.1) },
    { id: 11, conversation: 100, record: request(11, 100, 0.1, 60_000, 1000) },
    { id: 12, conversation: 101, record: request(12, 101, 0.2) },
    { id: 13, conversation: 102, record: request(13, 102, 0.05) },
    // #200: did not land.
    { id: 20, conversation: 200, record: request(20, 200, 0.3) },
    // #300: the standing agent, and its one subagent.
    { id: 30, conversation: 301, record: request(30, 301, 0.01) },
    ...[500, 501, 502, 503, 504].map((id) => ({
      id,
      conversation: 300,
      record: request(id, 300, 0.1),
    })),
    // Structure: the start events, a landing, the branch intents, the messages that dispatch, a fallback, a compaction.
    {
      id: 40,
      conversation: 1,
      record: event(40, 'event.subagents.started', {
        id: 100,
        agent: 'branch',
        kind: 'branch',
        parent: 1,
      }),
    },
    {
      id: 41,
      conversation: 1,
      record: event(41, 'event.subagents.started', {
        id: 200,
        agent: 'branch',
        kind: 'branch',
        parent: 1,
      }),
    },
    {
      id: 42,
      conversation: 1,
      record: event(42, 'event.subagents.started', {
        id: 300,
        agent: 'ultimate',
        kind: 'standing',
        parent: 1,
      }),
    },
    {
      id: 43,
      conversation: 1,
      record: event(43, 'event.subagents.started', {
        id: 301,
        agent: 'scout',
        kind: 'child',
        parent: 300,
      }),
    },
    {
      id: 44,
      conversation: 1,
      record: event(44, 'lineage.branched', { branch: 100, at: 9, intent: 'Do the thing' }),
    },
    {
      id: 45,
      conversation: 1,
      record: event(45, 'lineage.branched', { branch: 200, at: 9, intent: 'Try the other thing' }),
    },
    {
      id: 46,
      conversation: 1,
      record: event(46, 'event.subagents.started', {
        id: 101,
        agent: 'reviewer',
        kind: 'child',
        parent: 100,
      }),
    },
    {
      id: 47,
      conversation: 1,
      record: event(47, 'event.subagents.started', {
        id: 102,
        agent: 'worker',
        kind: 'child',
        parent: 100,
      }),
    },
    {
      id: 48,
      conversation: 1,
      record: event(48, 'event.workspaces.landed', {
        conversationId: 100,
        sha: 'abc1234def5678',
        target: 'main',
      }),
    },
    {
      id: 49,
      conversation: 1,
      record: event(
        49,
        'event.board.sent',
        { message: 1, from: 300, to: '100', reply: true },
        { conversationId: 300, entryId: 500 },
      ),
    },
    {
      id: 50,
      conversation: 1,
      record: event(
        50,
        'event.board.sent',
        { message: 2, from: 300, to: '100', reply: true },
        { conversationId: 300, entryId: 502 },
      ),
    },
    {
      id: 51,
      conversation: 1,
      record: event(
        51,
        'event.board.sent',
        { message: 3, from: 300, to: '200', reply: true },
        { conversationId: 300, entryId: 504 },
      ),
    },
    {
      id: 52,
      conversation: 301,
      record: JSON.stringify({
        kind: 'models.fallback',
        data: { from: 'llmhub/Qwen', to: 'llmhub/Mistral' },
        model: [{ role: 'user', content: 'switched', timestamp: T }],
      }),
    },
    {
      id: 53,
      conversation: 100,
      record: JSON.stringify({
        kind: 'pi.compaction',
        model: [{ role: 'user', content: 'summary', timestamp: T }],
      }),
    },
  ]
  const addEntry = db.prepare('insert into entries (id, conversation_id, record) values (?, ?, ?)')
  for (const row of rows) addEntry.run(row.id, row.conversation, row.record)

  // `pi.usage`, whose kind the store keeps JSON-quoted: each conversation's total, with #100's $0.05 larger than its
  // requests, which is the housekeeping inference no assistant entry holds.
  const addDocument = db.prepare('insert into documents (id, kind, owner_id) values (?, ?, ?)')
  const addRevision = db.prepare(
    'insert into document_revisions (document_id, seq, content) values (?, ?, ?)',
  )
  const totals: Record<number, number> = {
    100: 0.25,
    101: 0.2,
    102: 0.05,
    200: 0.3,
    300: 0.5,
    301: 0.01,
  }
  for (const [id, total] of Object.entries(totals)) {
    addDocument.run(Number(id), '"pi.usage"', Number(id))
    addRevision.run(
      Number(id),
      1,
      JSON.stringify({
        models: { 'deepseek/deepseek-flash': { totalTokens: 0, cost: { total } } },
      }),
    )
  }
  db.close()
  return path
}

const digest = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

it('sums a work order over its whole tree, and knows whether it landed', async () => {
  const path = await home(await machine(), 'demo-00000000')
  const result = report(read(path))
  const landed = result.workOrders.find((order) => order.conversation === 100)
  expect(landed?.cost).toBeCloseTo(0.45, 6)
  expect(landed?.conversations).toBe(3)
  expect(landed?.intent).toBe('Do the thing')
  expect(landed?.review).toBeCloseTo(0.2, 6)
  expect(landed?.landed).toEqual([{ sha: 'abc1234d', target: 'main' }])
  const missed = result.workOrders.find((order) => order.conversation === 200)
  expect(missed?.cost).toBeCloseTo(0.3, 6)
  expect(missed?.landed).toEqual([])
})

it('reports spend by role, the review share, and the usage no request accounts for', async () => {
  const path = await home(await machine(), 'demo-00000000')
  const result = report(read(path))
  const roles = new Map(result.roles.map((one) => [one.role, one.cost]))
  // Per role, a conversation's own requests only: #100's two and #200's one are the branches' turns.
  expect(roles.get('branch')).toBeCloseTo(0.5, 6)
  expect(roles.get('reviewer')).toBeCloseTo(0.2, 6)
  expect(roles.get('worker')).toBeCloseTo(0.05, 6)
  expect(result.classes.find((one) => one.class === 'review')?.cost).toBeCloseTo(0.2, 6)
  // $1.31 recorded in pi.usage against $1.26 of requests: #100's $0.05 of housekeeping.
  expect(result.totals.recorded).toBeCloseTo(1.31, 6)
  expect(result.totals.cost).toBeCloseTo(1.26, 6)
  expect(result.totals.untracked).toBeCloseTo(0.05, 6)
})

it('apportions a standing agent by the work orders its turns wrote to', async () => {
  const path = await home(await machine(), 'demo-00000000')
  const records = read(path)
  const shares = apportion(records, 300)
  // Three requests end in a turn that answers #100, two in one that answers #200.
  expect(shares.get(100)).toBeCloseTo(0.3, 6)
  expect(shares.get(200)).toBeCloseTo(0.2, 6)
  expect(shares.get(-1)).toBeUndefined()
  const coordination = report(records).coordination.find((one) => one.conversation === 300)
  expect(coordination?.sum.cost).toBeCloseTo(0.5, 6)
  expect(coordination?.dispatches).toBe(2)
  expect(coordination?.costPerDispatch).toBeCloseTo(0.25, 6)
})

it('finds the requests that re-billed a prompt the provider could not reuse', async () => {
  const path = await home(await machine(), 'demo-00000000')
  const result = report(read(path))
  expect(result.overhead.misses.requests).toBe(1)
  expect(result.overhead.misses.rerun).toBe(59_000)
})

it("reports a request's context, cost and compaction per conversation", async () => {
  const path = await home(await machine(), 'demo-00000000')
  const result = report(read(path))
  const branch = result.context.find((one) => one.conversation === 100)
  expect(branch?.sum.requests).toBe(2)
  expect(branch?.promptMax).toBe(60_000)
  expect(branch?.promptMedian).toBe(30_500)
  expect(branch?.compactions).toEqual([{ before: 60_000, after: 0, regrown: 0 }])
  expect(result.expensive[0]?.cost).toBeCloseTo(0.3, 6)
})

it('narrows to one work order and to a window', async () => {
  const path = await home(await machine(), 'demo-00000000')
  const records = read(path)
  const one = report(records, { work: 100 })
  expect(one.totals.conversations).toBe(3)
  expect(one.workOrders.map((order) => order.conversation)).toEqual([100])
  // The coordinator's share for the work order survives the filter, which leaves its own turns out.
  expect(one.workOrders[0].coordination).toBeCloseTo(0.3, 6)
  const later = report(records, { since: new Date(T + 1000) })
  expect(later.totals.requests).toBe(0)
  expect(format(one)).toContain('work order #100')
})

it('reads a home without writing to it', async () => {
  const path = await home(await machine(), 'demo-00000000')
  const before = await digest(join(path, 'state.sqlite'))
  read(path)
  expect(await digest(join(path, 'state.sqlite'))).toBe(before)
})

it('resolves a project by name, by home, and by the directory inside it', async () => {
  const userHome = await machine()
  const one = await home(userHome, 'demo-00000000', 'demo')
  const two = await home(userHome, 'other-11111111', 'other')
  expect(homes(userHome)).toContain(one)
  expect(resolveHome({ project: 'demo' }, userHome)).toBe(one)
  expect(resolveHome({ project: 'other' }, userHome)).toBe(two)
  expect(resolveHome({ home: two }, userHome)).toBe(two)
  expect(homeFor(join(two, 'worktrees', '1'), userHome)).toBe(two)
  expect(() => resolveHome({ project: 'nothing' }, userHome)).toThrow(/no project matches/)
})
