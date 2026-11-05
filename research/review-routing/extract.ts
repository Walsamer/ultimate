/**
 * Builds the experiment's dataset from git and the curated manifests next to it.
 *
 *   node research/review-routing/extract.ts           # rewrite cases.jsonl
 *   node research/review-routing/extract.ts --check   # verify the committed file, exit 1 on a mismatch
 *
 * A case's features come from the commit range alone, so every feature was computable before the review
 * started. Labels come from labels.json, which was read off the reviewers' own reports and the commits that
 * followed them — never inferred, never generated. Work orders are anchored by an explicit head sha so a
 * case can never drift when a branch moves.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { factsFromRange } from '../../lib/review-routing/facts.ts'
import type { ReviewFacts, Validation } from '../../lib/review-routing/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: here,
  encoding: 'utf8',
}).trim()
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

type Reviewed = {
  base: string
  head: string
  reviewers: number[]
  dims: string[]
  recomputable: boolean
}
type WorkOrder = { conversation: number; head: string; checks: Validation; reviewed?: Reviewed }
type Label = {
  ran: boolean
  conversation?: number
  verdict?: string
  findings?: number
  maxPriority?: string
  actioned?: boolean
  fixedIn?: string
  note: string
}
type Labels = Record<
  string,
  {
    reviewedBase: string
    reviewedHead: string
    landedAs: string
    dimensions: Record<string, Label>
  }
>

const workOrders = JSON.parse(readFileSync(join(here, 'work-orders.json'), 'utf8')) as WorkOrder[]
const labels = JSON.parse(readFileSync(join(here, 'labels.json'), 'utf8')) as Labels

/** The commit the work order forked from: the parent of the oldest commit that carries its trailer. */
const forkPoint = (conversation: number, head: string): string => {
  const found = git(
    'log',
    head,
    '--format=%H',
    '--grep',
    `^Ultimate-Conversation: ${conversation}$`,
  )
    .split('\n')
    .filter(Boolean)
  const oldest = found[found.length - 1]
  if (!oldest)
    throw new Error(
      `work order ${conversation}: no commit in ${head.slice(0, 8)} carries its trailer`,
    )
  return git('rev-parse', `${oldest}^`).trim()
}

const caseId = (conversation: number, head: string) => `wo-${conversation}-${head.slice(0, 8)}`

/** The dataset is committed: a merge subject can name the machine it came from, so paths never survive. */
const scrub = (subject: string): string =>
  subject
    .replace(/(?:\/[\w.-]+){2,}/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>')
    .replace(/^Merge branch '([^']+)' of <path> into (.+)$/, "Merge branch '$1' into $2")

export type Case = {
  id: string
  conversation: number
  base: string
  head: string
  provenance: {
    range: 'recorded-review' | 'fork-point'
    checks: string
    reviewers: number[]
    forkPoint: string
  }
  facts: ReviewFacts
  labels?: Record<string, Label>
}

const extract = (): Case[] =>
  workOrders.map((order) => {
    const base = order.reviewed?.base ?? forkPoint(order.conversation, order.head)
    const computed = forkPoint(order.conversation, order.head)
    // The work order's own commits, oldest first — each commit's change against its own first parent, so
    // work merged in from the target is never counted as this work order's and does not inflate its size.
    const shas = git(
      'log',
      order.head,
      '--format=%H',
      '--grep',
      `^Ultimate-Conversation: ${order.conversation}$`,
    )
      .split('\n')
      .filter(Boolean)
      .toReversed()
    if (shas.length === 0)
      throw new Error(
        `work order ${order.conversation}: ${order.head.slice(0, 8)} has no own commits`,
      )
    const parents = (sha: string) =>
      git('log', '-1', '--format=%p', sha).trim().split(/\s+/).filter(Boolean)
    // A merge in the work order's own history is usually a sync with the target, whose diff against its first
    // parent is somebody else's work. Only a work order that exists as merges alone is measured by them.
    const own = shas.filter((sha) => parents(sha).length < 2)
    const counted = own.length > 0 ? own : shas
    const subjects = shas.map((sha) => scrub(git('log', '-1', '--format=%s', sha).trim()))
    const numstat = counted.flatMap((sha) =>
      git('diff', '--numstat', '-M', `${sha}^`, sha).split('\n').filter(Boolean),
    )
    const nameStatus = counted.flatMap((sha) =>
      git('diff', '--name-status', '-M', `${sha}^`, sha).split('\n').filter(Boolean),
    )
    const id = caseId(order.conversation, order.head)
    const facts = factsFromRange({
      id,
      base,
      head: order.head,
      subjects,
      numstat,
      nameStatus,
      validation: order.checks,
    })
    const label = labels[id]
    return {
      id,
      conversation: order.conversation,
      base,
      head: order.head,
      provenance: {
        range: order.reviewed ? ('recorded-review' as const) : ('fork-point' as const),
        checks: `${order.checks} (from the workspace record's lander check runs)`,
        reviewers: order.reviewed?.reviewers ?? [],
        // What git recomputes as the fork point, so the check below can compare it to the recorded base.
        forkPoint: computed,
      },
      facts,
      ...(label ? { labels: label.dimensions } : {}),
    }
  })

const cases = extract()
const rendered = cases.map((item) => JSON.stringify(item)).join('\n') + '\n'

const check = async () => {
  const committed = readFileSync(join(here, 'cases.jsonl'), 'utf8')
  const problems: string[] = []
  if (committed !== rendered) problems.push('cases.jsonl differs from a fresh extraction')
  const ids = new Set<string>()
  for (const item of cases) {
    if (ids.has(item.id)) problems.push(`duplicate case id ${item.id}`)
    ids.add(item.id)
    if (item.labels && !item.provenance.reviewers.length)
      problems.push(`${item.id} carries labels but no recorded review`)
    if (item.head === item.base) problems.push(`${item.id} has an empty range`)
  }
  // Features must never leak the host: the dataset is committed, so no absolute path may reach it.
  if (/\/Users\/|\/Volumes\/|[A-Za-z]:\\/.test(rendered))
    problems.push('an absolute host path reached the dataset')
  const recorded = cases.filter((item) => item.provenance.range === 'recorded-review')
  for (const item of recorded) {
    const order = workOrders.find((candidate) => candidate.conversation === item.conversation)!
    if (item.base !== order.reviewed!.base)
      problems.push(`${item.id}: base ${item.base} is not the recorded review base`)
    const gap = Number(
      git('rev-list', '--count', `${order.reviewed!.base}..${item.provenance.forkPoint}`).trim(),
    )
    if (item.provenance.forkPoint === item.base)
      console.log(`${item.id}: recorded base reproduced exactly by the fork point`)
    else if (Number.isFinite(gap) && gap <= 2)
      console.log(
        `${item.id}: recorded base is ${gap} untrailered commit(s) earlier than the fork point — pinned from the review record`,
      )
    else
      problems.push(
        `${item.id}: recorded base is ${gap} commits away from the fork point, which is too far to explain`,
      )
  }
  if (problems.length) {
    console.error(problems.map((problem) => `FAIL ${problem}`).join('\n'))
    process.exit(1)
  }
  console.log(
    `${cases.length} cases, ${recorded.length} with recorded-review labels, all invariants hold`,
  )
}

if (process.argv.includes('--check')) await check()
else {
  writeFileSync(join(here, 'cases.jsonl'), rendered)
  console.log(
    `wrote ${cases.length} cases (${cases.filter((item) => item.labels).length} labelled)`,
  )
}
