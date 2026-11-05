// What work cost, all in. Reads one project home's records and reports the spend per work order (a branch conversation
// and every agent it started), by role and model, the context each request carried, what compaction, retries and
// fallbacks cost, and the share review takes.
//
// Every number comes from records the host already writes: an assistant entry carries its own tokens and cost, the
// branch, message and landing events carry the structure, and the `pi.usage` document keeps the running total they are
// checked against. Nothing is instrumented, no inference runs and no database is opened for writing.
//
// Usage: pnpm cost [--project <name> | --home <dir>] [--work <id>] [--since <date>] [--until <date>] [--top <n>]
// [--json]. Background and the reconstruction it rests on: docs/audit/token-cost.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

/** One model request, as its assistant entry records it: tokens, cost, latency and how it ended. */
export interface Request {
  conversation: number
  entry: number
  at?: number
  provider?: string
  model?: string
  /** What the model was billed for before it answered: the whole prompt, cached and uncached. */
  prompt: number
  cacheRead: number
  output: number
  reasoning: number
  tokens: number
  cost: number
  ms?: number
  stop?: string
  error?: string
}

/** A request with the role of the conversation that made it. */
export interface Scored extends Request {
  role: string
}

/** How a conversation came to exist: the agent that runs it, and what started it. */
export interface Started {
  agent: string
  kind: string
  parent?: number
}

export interface Landing {
  sha: string
  target?: string
}

/** A message one conversation sent another, and the sender's entry that sent it. */
export interface Send {
  from: number
  /** The recipient conversation, or -1 for the user and for a remote agent, which no cost belongs to. */
  to: number
  /** The sender's entry, which places the message in its own transcript. */
  entry?: number
}

export interface CostRecords {
  home: string
  name: string
  conversations: Map<number, number | undefined>
  requests: Request[]
  /** Cost per conversation as `pi.usage` totals it, which includes inference that no assistant entry holds. */
  recorded: Map<number, number>
  started: Map<number, Started>
  intents: Map<number, string>
  landings: Map<number, Landing[]>
  sends: Send[]
  fallbacks: { conversation: number; from: string; to: string; reason: string }[]
  compactions: { conversation: number; entry: number }[]
  failures: { conversation: number; step: string; retried: boolean }[]
}

const REQUEST_SQL = `select id, conversation_id,
    json_extract(record, '$.model[0].timestamp') at,
    json_extract(record, '$.model[0].provider') provider,
    json_extract(record, '$.model[0].model') model,
    json_extract(record, '$.model[0].usage.input') input,
    json_extract(record, '$.model[0].usage.cacheRead') cacheRead,
    json_extract(record, '$.model[0].usage.cacheWrite') cacheWrite,
    json_extract(record, '$.model[0].usage.output') output,
    json_extract(record, '$.model[0].usage.reasoning') reasoning,
    json_extract(record, '$.model[0].usage.totalTokens') total,
    json_extract(record, '$.model[0].usage.cost.total') cost,
    json_extract(record, '$.model[0].durationMs') ms,
    json_extract(record, '$.model[0].stopReason') stop,
    json_extract(record, '$.model[0].errorMessage') error
  from entries where json_valid(record) and json_extract(record, '$.kind') = 'pi.assistant'`

const EVENT_SQL = `select id, conversation_id, json_extract(record, '$.kind') kind,
    json_extract(record, '$.data') data
  from entries where json_valid(record) and json_extract(record, '$.kind') in (
    'event.subagents.started', 'event.workspaces.landed', 'event.board.sent', 'lineage.branched',
    'models.fallback', 'pi.compaction', 'watchdog.failure')`

const USAGE_SQL = `select d.owner_id conversation, r.content
  from documents d join document_revisions r on r.document_id = d.id
  where d.kind = '"pi.usage"' and r.seq = (select max(seq) from document_revisions where document_id = d.id)`

/** The projects this machine has a home for: `<home>/project.json` names the folder each one belongs to. */
export function homes(userHome = homedir()): string[] {
  const folder = join(userHome, '.ultimate', 'projects')
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, 'state.sqlite')))
    .map((entry) => join(folder, entry.name))
    .toSorted()
}

const projectOf = (home: string): { root?: string; name?: string } => {
  const file = join(home, 'project.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { root?: string; name?: string }
  } catch {
    // A home whose record is unreadable still has a name in its folder, and the report only needs that.
    return {}
  }
}

const nameOf = (home: string) => projectOf(home).name ?? basename(home)

/** The home a directory belongs to: the one it sits in (a worktree), or the one that names it as its project folder. */
export function homeFor(cwd: string, userHome = homedir()): string | undefined {
  const all = homes(userHome)
  const inside = all.find((home) => cwd === home || cwd.startsWith(home + sep))
  if (inside) return inside
  return all.find((home) => {
    const root = projectOf(home).root
    return !!root && (cwd === root || cwd.startsWith(root + sep))
  })
}

/** The home `--home`, `--project` or the working directory names; throws with the ones this machine has. */
export function resolveHome(
  options: { home?: string; project?: string; cwd?: string },
  userHome = homedir(),
): string {
  const all = homes(userHome)
  const list = () => all.map((home) => `  ${nameOf(home)} — ${home}`).join('\n') || '  none'
  if (options.home) {
    if (!existsSync(join(options.home, 'state.sqlite')))
      throw new Error(`no state.sqlite in ${options.home}`)
    return options.home
  }
  if (options.project) {
    const wanted = options.project.toLowerCase()
    const matches = all.filter((home) => nameOf(home).toLowerCase().includes(wanted))
    const [only] = matches
    if (only && matches.length === 1) return only
    if (matches.length > 1)
      throw new Error(`"${options.project}" names ${matches.length} projects:\n${list()}`)
    throw new Error(`no project matches "${options.project}":\n${list()}`)
  }
  const cwd = options.cwd ?? process.cwd()
  const found = homeFor(cwd, userHome)
  if (!found) throw new Error(`no project home for ${cwd}:\n${list()}`)
  return found
}

const number = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

/** Read one home's records. The database is opened read-only and closed before this returns. */
export function read(home: string): CostRecords {
  const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
  try {
    const conversations = new Map<number, number | undefined>()
    const parents = db.prepare(
      `select id, json_extract(record, '$.parent.conversationId') parent from conversations`,
    )
    for (const row of parents.all())
      conversations.set(number(row.id), row.parent === null ? undefined : number(row.parent))

    const requests: Request[] = db
      .prepare(REQUEST_SQL)
      .all()
      .map((row) => ({
        conversation: number(row.conversation_id),
        entry: number(row.id),
        at: row.at === null ? undefined : number(row.at),
        provider: text(row.provider),
        model: text(row.model),
        prompt: number(row.input) + number(row.cacheRead) + number(row.cacheWrite),
        cacheRead: number(row.cacheRead),
        output: number(row.output),
        reasoning: number(row.reasoning),
        tokens: number(row.total),
        cost: number(row.cost),
        ms: row.ms === null ? undefined : number(row.ms),
        stop: text(row.stop),
        error: text(row.error),
      }))

    const recorded = new Map<number, number>()
    for (const row of db.prepare(USAGE_SQL).all()) {
      let models: Record<string, { cost?: { total?: number } }>
      try {
        models = (JSON.parse(String(row.content)) as { models?: typeof models }).models ?? {}
      } catch {
        // A usage snapshot that is not JSON leaves no total to check the requests against; the report says so.
        continue
      }
      recorded.set(
        number(row.conversation),
        Object.values(models).reduce((total, model) => total + number(model.cost?.total), 0),
      )
    }

    const started = new Map<number, Started>()
    const intents = new Map<number, string>()
    const landings = new Map<number, Landing[]>()
    const sends: Send[] = []
    const fallbacks: CostRecords['fallbacks'] = []
    const compactions: CostRecords['compactions'] = []
    const failures: CostRecords['failures'] = []
    for (const row of db.prepare(EVENT_SQL).all()) {
      const kind = String(row.kind)
      const data =
        row.data === null ? {} : (JSON.parse(String(row.data)) as Record<string, unknown>)
      // An extension event wraps its payload (`{v, at, data, context}`); a tool record holds it directly.
      const payload = (data.data ?? data) as Record<string, unknown>
      if (kind === 'event.subagents.started')
        started.set(number(payload.id), {
          agent: String(payload.agent),
          kind: String(payload.kind),
          parent:
            payload.parent === null || payload.parent === undefined
              ? undefined
              : number(payload.parent),
        })
      else if (kind === 'lineage.branched')
        intents.set(number(payload.branch), String(payload.intent))
      else if (kind === 'event.workspaces.landed') {
        const conversation = number(payload.conversationId)
        landings.set(conversation, [
          ...(landings.get(conversation) ?? []),
          { sha: String(payload.sha).slice(0, 8), target: text(payload.target) },
        ])
      } else if (kind === 'event.board.sent') {
        const to = Number(payload.to)
        const context = data.context as { entryId?: number } | undefined
        sends.push({
          from: number(payload.from),
          to: Number.isFinite(to) ? to : -1,
          entry: context?.entryId,
        })
      } else if (kind === 'models.fallback')
        fallbacks.push({
          conversation: number(row.conversation_id),
          from: String(payload.from),
          to: String(payload.to),
          reason: String(payload.reason),
        })
      else if (kind === 'pi.compaction')
        compactions.push({ conversation: number(row.conversation_id), entry: number(row.id) })
      else if (kind === 'watchdog.failure')
        failures.push({
          conversation: number(payload.conversation),
          step: String(payload.step),
          retried: payload.retried === true,
        })
    }

    return {
      home,
      name: nameOf(home),
      conversations,
      requests,
      recorded,
      started,
      intents,
      landings,
      sends,
      fallbacks,
      compactions,
      failures,
    }
  } finally {
    db.close()
  }
}

export type Class = 'review' | 'recon' | 'implement' | 'other'

const classOf = (role: string): Class => {
  if (role.startsWith('review')) return 'review'
  if (role === 'scout') return 'recon'
  if (/^(worker|designer|branch|coordinator|ultimate|root)$/.test(role)) return 'implement'
  return 'other'
}

export interface Sum {
  cost: number
  tokens: number
  requests: number
}

const sum = (requests: Request[]): Sum => ({
  cost: requests.reduce((total, request) => total + request.cost, 0),
  tokens: requests.reduce((total, request) => total + request.tokens, 0),
  requests: requests.length,
})

const add = (a: Sum, b: Sum): Sum => ({
  cost: a.cost + b.cost,
  tokens: a.tokens + b.tokens,
  requests: a.requests + b.requests,
})

const empty = (): Sum => ({ cost: 0, tokens: 0, requests: 0 })

export interface WorkOrder extends Sum {
  conversation: number
  role: string
  intent: string
  landed: Landing[]
  /** What its review agents cost: part of `cost`, not in addition to it. */
  review: number
  /** A coordinator's own turns apportioned here: reported beside `cost`, never added to it. */
  coordination: number
  conversations: number
}

export interface Report {
  home: string
  name: string
  work?: number
  /** The window the requests were taken from, in the words the header shows; undefined for every record. */
  window?: string
  totals: Sum & {
    conversations: number
    recorded: number
    untracked: number
    failed: number
    failedMs: number
  }
  roles: ({ role: string; class: Class } & Sum)[]
  models: ({ model: string } & Sum)[]
  workOrders: WorkOrder[]
  context: {
    conversation: number
    role: string
    sum: Sum
    promptMedian: number
    promptMax: number
    cacheShare: number
    compactions: { before: number; after: number; regrown: number }[]
  }[]
  overhead: {
    failed: { stop: string; requests: number; ms: number }[]
    fallbacks: {
      conversation: number
      role: string
      from: string
      to: string
      reason: string
      after?: number
    }[]
    compactions: number
    retried: number
    /** Requests whose prompt the provider could not reuse, and how many tokens it billed as new input instead. */
    misses: Sum & { rerun: number }
  }
  expensive: Scored[]
  widest: Scored[]
  classes: ({ class: Class } & Sum)[]
  coordination: {
    conversation: number
    role: string
    sum: Sum
    dispatches: number
    costPerDispatch: number
    apportioned: { workOrder: number; cost: number }[]
    unattributed: number
  }[]
}

/** The conversations a branch started: its own, and every agent's under it. */
export const subtree = (records: CostRecords, conversation: number): number[] => {
  const children = new Map<number, number[]>()
  for (const id of records.conversations.keys()) {
    // A child's link is in Pi Durable's own parent, or in the start event for the agents started later.
    const parent = records.started.get(id)?.parent ?? records.conversations.get(id)
    if (parent === undefined || !records.conversations.has(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), id])
  }
  const walk = (id: number): number[] => [id, ...(children.get(id) ?? []).flatMap(walk)]
  return walk(conversation)
}

/**
 * A standing conversation's own turns, split by the work order each one served. A turn belongs to the work orders it
 * last wrote to in that turn: the conversation it answered, which is where the turn was headed. A turn that writes to
 * several shares its cost evenly between them, and the turns after its final message stay unattributed.
 */
export function apportion(
  records: CostRecords,
  conversation: number,
  requests = records.requests,
): Map<number, number> {
  const marks = new Map<number, number[]>()
  for (const send of records.sends) {
    if (send.from !== conversation || send.entry === undefined || send.to <= 0) continue
    const targets = marks.get(send.entry) ?? []
    if (!targets.includes(send.to)) targets.push(send.to)
    marks.set(send.entry, targets)
  }
  const entries = [...marks.keys()].toSorted((a, b) => a - b)
  const shares = new Map<number, number>()
  const credit = (target: number, cost: number) =>
    shares.set(target, (shares.get(target) ?? 0) + cost)
  for (const request of requests.filter((one) => one.conversation === conversation)) {
    // The turn that sends a message is the turn it decided on: the send's own entry belongs to its recipients.
    const next = entries.find((entry) => entry >= request.entry)
    const targets = next === undefined ? [] : (marks.get(next) ?? [])
    if (!targets.length) credit(-1, request.cost)
    else for (const target of targets) credit(target, request.cost / targets.length)
  }
  return shares
}

export function report(
  records: CostRecords,
  options: { since?: Date; until?: Date; top?: number; work?: number } = {},
): Report {
  const top = options.top ?? 8
  const since = options.since?.getTime()
  const until = options.until?.getTime()
  const inside = (request: Request) =>
    (since === undefined || (request.at ?? 0) >= since) &&
    (until === undefined || (request.at ?? 0) <= until)
  const allowed = options.work === undefined ? undefined : new Set(subtree(records, options.work))
  const requests = records.requests.filter(
    (request) => inside(request) && (allowed === undefined || allowed.has(request.conversation)),
  )
  const roles = new Map<number, string>()
  const roleOfCached = (conversation: number) => {
    const cached = roles.get(conversation)
    if (cached) return cached
    const found = records.started.get(conversation)?.agent
    const answer =
      found ??
      (records.requests.some((request) => request.conversation === conversation) ? 'root' : 'infra')
    roles.set(conversation, answer)
    return answer
  }
  const byConversation = new Map<number, Request[]>()
  for (const request of requests)
    byConversation.set(request.conversation, [
      ...(byConversation.get(request.conversation) ?? []),
      request,
    ])
  const treeCost = (conversation: number): Sum => {
    let total = sum(byConversation.get(conversation) ?? [])
    for (const id of subtree(records, conversation).slice(1))
      total = add(total, sum(byConversation.get(id) ?? []))
    return total
  }

  const totals = sum(requests)
  const recorded = [...records.recorded.values()].reduce((summed, cost) => summed + cost, 0)
  const failing = requests.filter(
    (request) => request.stop === 'error' || request.stop === 'aborted',
  )

  const byRole = new Map<string, Sum>()
  const models = new Map<string, Sum>()
  const classes = new Map<Class, Sum>()
  for (const request of requests) {
    const one = sum([request])
    const name = roleOfCached(request.conversation)
    const model = `${request.provider ?? '?'}/${request.model ?? '?'}`
    byRole.set(name, add(byRole.get(name) ?? empty(), one))
    models.set(model, add(models.get(model) ?? empty(), one))
    classes.set(classOf(name), add(classes.get(classOf(name)) ?? empty(), one))
  }

  const coordination: Report['coordination'] = []
  const apportioned = new Map<number, number>()
  // A work order's own report still credits the coordinator's turns to it, which a filter of its subtree would drop.
  const apportionOver = options.work === undefined ? requests : records.requests
  for (const [conversation, started] of records.started) {
    if (started.kind !== 'standing') continue
    const shares = apportion(records, conversation, apportionOver)
    for (const [target, cost] of shares)
      if (target > 0) apportioned.set(target, (apportioned.get(target) ?? 0) + cost)
    const ownSum = sum(byConversation.get(conversation) ?? [])
    const dispatches = new Set(
      records.sends
        .filter((send) => send.from === conversation && send.to > 0)
        .map((send) => send.to),
    ).size
    coordination.push({
      conversation,
      role: roleOfCached(conversation),
      sum: ownSum,
      dispatches,
      costPerDispatch: dispatches ? ownSum.cost / dispatches : 0,
      apportioned: [...shares]
        .filter(([target]) => target > 0)
        .map(([workOrder, cost]) => ({ workOrder, cost }))
        .toSorted((a, b) => b.cost - a.cost),
      unattributed: shares.get(-1) ?? 0,
    })
  }
  coordination.sort((a, b) => b.sum.cost - a.sum.cost)

  const workOrders: WorkOrder[] = [...records.conversations.keys()]
    .filter((conversation) => records.started.get(conversation)?.kind === 'branch')
    .map((conversation) => {
      const subtreeIds = subtree(records, conversation).slice(1)
      return {
        ...treeCost(conversation),
        conversation,
        role: roleOfCached(conversation),
        intent: records.intents.get(conversation) ?? '',
        landed: records.landings.get(conversation) ?? [],
        review: subtreeIds
          .filter((id) => classOf(roleOfCached(id)) === 'review')
          .reduce((total, id) => total + sum(byConversation.get(id) ?? []).cost, 0),
        coordination: apportioned.get(conversation) ?? 0,
        conversations: subtreeIds.length + 1,
      }
    })
    .filter((order) => order.requests > 0)
    .toSorted((a, b) => b.cost - a.cost)

  const median = (values: number[]): number => {
    if (!values.length) return 0
    const sorted = values.toSorted((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }

  const context: Report['context'] = [...byConversation]
    .map(([conversation, own]) => {
      const prompts = own.map((request) => request.prompt)
      const cacheRead = own.reduce((total, request) => total + request.cacheRead, 0)
      const prompt = own.reduce((total, request) => total + request.prompt, 0)
      const compactions = records.compactions
        .filter((compaction) => compaction.conversation === conversation)
        .map((compaction) => {
          const before = own.filter((request) => request.entry < compaction.entry)
          const after = own.filter((request) => request.entry > compaction.entry)
          const peak = before.reduce((max, request) => Math.max(max, request.prompt), 0)
          // How many requests it took to carry as much again as compaction removed.
          const regrown = after.findIndex((request) => request.prompt >= peak) + 1
          return { before: peak, after: after[0]?.prompt ?? 0, regrown }
        })
      return {
        conversation,
        role: roleOfCached(conversation),
        sum: sum(own),
        promptMedian: median(prompts),
        promptMax: Math.max(0, ...prompts),
        cacheShare: prompt ? cacheRead / prompt : 0,
        compactions,
      }
    })
    .filter((entry) => entry.sum.requests > 0)

  const fallbacks = records.fallbacks
    .filter((fallback) => allowed === undefined || allowed.has(fallback.conversation))
    .map((fallback) => {
      const target = fallback.to.split('/').at(-1)
      const resumed = (byConversation.get(fallback.conversation) ?? []).find(
        (request) => request.model === target || request.model === fallback.to,
      )
      return {
        ...fallback,
        role: roleOfCached(fallback.conversation),
        after: resumed?.prompt,
      }
    })

  const scored: Scored[] = requests.map((request) => ({
    ...request,
    role: roleOfCached(request.conversation),
  }))
  // A prompt the provider could not reuse: the whole conversation went again at the price of new input.
  const misses = requests.filter(
    (request) => request.prompt >= 50_000 && request.cacheRead < request.prompt / 2,
  )

  return {
    home: records.home,
    name: records.name,
    work: options.work,
    window:
      since === undefined && until === undefined
        ? undefined
        : `${since === undefined ? 'from the start' : `from ${options.since?.toISOString().slice(0, 10)}`} to ${until === undefined ? 'now' : options.until?.toISOString().slice(0, 10)}`,
    totals: {
      ...totals,
      conversations: new Set(requests.map((request) => request.conversation)).size,
      recorded,
      untracked: recorded - totals.cost,
      failed: failing.length,
      failedMs: failing.reduce((total, request) => total + (request.ms ?? 0), 0),
    },
    roles: [...byRole]
      .map(([name, sums]) => ({ role: name, class: classOf(name), ...sums }))
      .toSorted((a, b) => b.cost - a.cost),
    models: [...models]
      .map(([model, sums]) => ({ model, ...sums }))
      .toSorted((a, b) => b.cost - a.cost),
    workOrders,
    context: context.toSorted((a, b) => b.promptMax - a.promptMax),
    overhead: {
      failed: [...Map.groupBy(failing, (request) => request.stop ?? 'error')].map(
        ([stop, group]) => ({
          stop,
          requests: group.length,
          ms: group.reduce((total, request) => total + (request.ms ?? 0), 0),
        }),
      ),
      fallbacks,
      compactions: records.compactions.length,
      retried: records.failures.filter((failure) => failure.retried).length,
      misses: {
        ...sum(misses),
        rerun: misses.reduce((total, request) => total + (request.prompt - request.cacheRead), 0),
      },
    },
    expensive: scored.toSorted((a, b) => b.cost - a.cost).slice(0, top),
    widest: scored.toSorted((a, b) => b.prompt - a.prompt).slice(0, top),
    classes: [...classes].map(([name, sums]) => ({ class: name, ...sums })),
    coordination,
  }
}

const money = (value: number, digits = 2) => `$${value.toFixed(digits)}`

const tokens = (value: number) =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(1)}B`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)}M`
      : value >= 1e3
        ? `${Math.round(value / 1e3)}k`
        : String(Math.round(value))

const percent = (value: number) => `${Math.round(value * 100)}%`

const clip = (line: string, width: number) =>
  line.length > width ? `${line.slice(0, width - 1)}…` : line.padEnd(width)

const table = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]),
      )
      .join('  ')
  return [line(headers), ...rows.map(line)].join('\n')
}

/** The report as text: one section per question it answers. */
export function format(result: Report): string {
  const out: string[] = []
  const ofTotal = (cost: number) => percent(cost / (result.totals.cost || 1))
  out.push(`${result.name} · ${result.home}`)
  out.push(
    result.work === undefined
      ? `${result.window ?? 'every record'} · ${result.totals.requests} requests over ${result.totals.conversations} conversations`
      : `work order #${result.work} · ${result.totals.requests} requests over ${result.totals.conversations} conversations`,
  )

  out.push('', '## Spend')
  out.push(`  ${money(result.totals.cost)} · ${tokens(result.totals.tokens)} tokens`)
  if (result.work === undefined && !result.window)
    out.push(
      `  ${money(result.totals.recorded)} recorded by pi.usage, ${money(result.totals.untracked)} of it outside any assistant entry`,
    )
  out.push('')
  out.push(
    table(
      ['role', 'cost', 'share', 'tokens', 'requests'],
      result.roles.map((one) => [
        one.role,
        money(one.cost),
        ofTotal(one.cost),
        tokens(one.tokens),
        String(one.requests),
      ]),
    ),
  )
  out.push('')
  out.push(
    table(
      ['model', 'cost', 'share', 'tokens', 'requests'],
      result.models.map((one) => [
        one.model,
        money(one.cost),
        ofTotal(one.cost),
        tokens(one.tokens),
        String(one.requests),
      ]),
    ),
  )

  out.push('', '## Work orders')
  out.push('  a branch conversation with every agent it started; cost already includes its reviews')
  out.push(
    table(
      ['#', 'role', 'cost', 'tokens', 'reqs', 'convs', 'review', 'coord', 'outcome', 'work'],
      result.workOrders.map((order) => [
        `#${order.conversation}`,
        order.role,
        money(order.cost),
        tokens(order.tokens),
        String(order.requests),
        String(order.conversations),
        order.review ? money(order.review) : '—',
        order.coordination ? money(order.coordination) : '—',
        order.landed.length
          ? `${order.landed[0].target ?? '?'} ${order.landed[0].sha}`
          : 'not landed',
        clip(order.intent.replaceAll('\n', ' '), 50),
      ]),
    ),
  )

  out.push('', '## Context')
  out.push(
    '  prompt tokens billed per request: the whole conversation sent again, cached plus uncached',
  )
  out.push(
    table(
      ['#', 'role', 'reqs', 'median', 'widest', 'cached', 'cost', 'compaction'],
      result.context
        .slice(0, 12)
        .map((one) => [
          `#${one.conversation}`,
          one.role,
          String(one.sum.requests),
          tokens(one.promptMedian),
          tokens(one.promptMax),
          percent(one.cacheShare),
          money(one.sum.cost),
          one.compactions.map((each) => `${tokens(each.before)}→${tokens(each.after)}`).join(' ') ||
            '—',
        ]),
    ),
  )

  const overhead = result.overhead
  out.push('', '## Overhead')
  out.push(
    `  ${result.totals.failed} requests failed, ${(result.totals.failedMs / 1000).toFixed(0)}s spent and no tokens billed` +
      (overhead.failed.length
        ? `: ${overhead.failed.map((one) => `${one.requests} ${one.stop}`).join(', ')}`
        : ''),
  )
  out.push(`  retried after a failure ${overhead.retried} · compactions ${overhead.compactions}`)
  out.push(
    `  ${overhead.misses.requests} requests sent a prompt the provider could not reuse (50k or more, under half cached): ` +
      `${money(overhead.misses.cost)} · ${tokens(overhead.misses.rerun)} tokens billed as new input`,
  )
  for (const fallback of overhead.fallbacks)
    out.push(
      `  fallback in #${fallback.conversation} (${fallback.role}): ${fallback.from} → ${fallback.to} · ${fallback.reason}` +
        (fallback.after === undefined ? '' : ` · next prompt ${tokens(fallback.after)}`),
    )

  out.push('', '## Most expensive requests')
  out.push(
    table(
      ['#', 'role', 'entry', 'model', 'prompt', 'output', 'ms', 'cost'],
      result.expensive.map((one) => [
        `#${one.conversation}`,
        one.role,
        String(one.entry),
        one.model ?? '?',
        tokens(one.prompt),
        tokens(one.output),
        String(Math.round(one.ms ?? 0)),
        money(one.cost, 4),
      ]),
    ),
  )

  out.push('', '## Widest prompts')
  out.push(
    table(
      ['#', 'role', 'entry', 'prompt', 'cached', 'output', 'cost'],
      result.widest.map((one) => [
        `#${one.conversation}`,
        one.role,
        String(one.entry),
        tokens(one.prompt),
        tokens(one.cacheRead),
        tokens(one.output),
        money(one.cost, 4),
      ]),
    ),
  )

  out.push('', '## Review share')
  for (const one of result.classes.toSorted((a, b) => b.cost - a.cost))
    out.push(
      `  ${one.class.padEnd(12)} ${money(one.cost).padStart(8)}  ${ofTotal(one.cost).padStart(4)}  ${tokens(one.tokens).padStart(7)}`,
    )
  out.push(
    "  a work order's own coordinator turns are its implementation; only review agents count as review",
  )

  if (result.coordination.length) {
    out.push('', '## Coordination')
    out.push(
      "  a standing agent's own turns, which belong to no single work order: apportioned, never added in",
    )
    out.push(
      table(
        ['#', 'role', 'cost', 'reqs', 'started', 'per start', 'unattributed'],
        result.coordination.map((one) => [
          `#${one.conversation}`,
          one.role,
          money(one.sum.cost),
          String(one.sum.requests),
          String(one.dispatches),
          money(one.costPerDispatch),
          money(one.unattributed),
        ]),
      ),
    )
    for (const one of result.coordination)
      if (one.apportioned.length)
        out.push(
          `  #${one.conversation} by work order: ` +
            one.apportioned
              .slice(0, 8)
              .map((each) => `#${each.workOrder} ${money(each.cost)}`)
              .join(' · ') +
            (one.apportioned.length > 8 ? ` · and ${one.apportioned.length - 8} more` : ''),
        )
  }
  return out.join('\n')
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      home: { type: 'string' },
      project: { type: 'string' },
      work: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      top: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const finish = (message: string): never => {
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }
  const home = resolveHome({ home: values.home, project: values.project })
  const records = read(home)
  const work = values.work === undefined ? undefined : Number(values.work.replace('#', ''))
  if (work !== undefined && !Number.isFinite(work))
    finish(`--work needs a conversation number, not ${values.work}`)
  if (work !== undefined && !records.conversations.has(work))
    finish(`no conversation #${work} in ${home}`)
  const result = report(records, {
    since: values.since === undefined ? undefined : new Date(values.since),
    until: values.until === undefined ? undefined : new Date(values.until),
    top: values.top === undefined ? undefined : Number(values.top),
    work,
  })
  process.stdout.write(`${values.json ? JSON.stringify(result, undefined, 2) : format(result)}\n`)
}
