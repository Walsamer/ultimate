/**
 * Pre-review facts, derived from git plumbing output alone: nothing here reads the *review* — no verdict,
 * no finding, no cost — so a case built with it could have been computed before the review started.
 * The git calls live in `research/review-routing/extract.ts`; this module is pure text in, facts out.
 */
import type { Area, ChangeType, ReviewFacts, Validation } from './types.ts'

export type GitRangeInput = {
  /** The case id this range belongs to: `wo-<conversation>-<head8>`. */
  id: string
  base: string
  head: string
  /** Commit subjects, oldest first. */
  subjects: string[]
  /** `git diff --numstat base..head` lines: `added\tdeleted\tpath` (`-` for binary). */
  numstat: string[]
  /** `git diff --name-status -M base..head` lines: `M\tpath`, `R100\told\tnew`. */
  nameStatus: string[]
  validation?: Validation
}

/** Paths whose change means a document kind, event, protocol or storage shape moved. */
const schema = [
  'shared/protocol.ts',
  'shared/events.ts',
  'shared/extension-api.ts',
  'server/storage',
  'lib/storage',
  'docs/durability.md',
]

/** Secrets, auth, process execution, path handling, an HTTP surface. */
const security = [
  'secrets',
  'auth',
  'login',
  'owned-env',
  'exec',
  'spawn',
  'shell',
  'process-group',
  'request-security',
  'http.ts',
  'api.ts',
]

const areaOf = (path: string): Area => {
  if (path.startsWith('server/')) return 'core-server'
  if (path.startsWith('shared/')) return 'core-shared'
  if (path.startsWith('web/')) return 'core-web'
  if (path.startsWith('lib/')) return 'lib'
  if (path.startsWith('.ultimate/extensions/')) return 'project-extension'
  if (path.startsWith('extensions/')) return 'extension'
  if (path.startsWith('agents/') || path.startsWith('.ultimate/agents/')) return 'agents'
  if (path.startsWith('skills/') || path.startsWith('.ultimate/skills/')) return 'skills'
  if (path.startsWith('docs/')) return 'docs'
  if (path.startsWith('test/')) return 'test'
  if (path.startsWith('bin/') || path.startsWith('scripts/') || path.startsWith('lint/'))
    return 'tooling'
  return 'other'
}

const extensionOf = (path: string): string | undefined => {
  const match = /^(?:\.ultimate\/)?extensions\/([^/]+)\//.exec(path)
  return match?.[1]
}

const isTest = (path: string) => path.startsWith('test/') || /\.test\.[cm]?tsx?$/.test(path)
const isDocs = (path: string) =>
  path.startsWith('docs/') || /^[^/]+\.md$/.test(path) || path.endsWith('README.md')

/** A commit's subject is the cheapest honest signal of the work order's type. */
export const changeTypeOf = (subjects: string[], paths: string[]): ChangeType => {
  const first = subjects[0]?.toLowerCase() ?? ''
  if (!first) return 'unknown'
  if (paths.length > 0 && paths.every((path) => isDocs(path))) return 'docs'
  if (/^(docs|doc)[: ]/.test(first)) return 'docs'
  if (/^(test|tests):/.test(first)) return 'test'
  if (/^(fix|repair|revert)[: ]/.test(first)) return 'fix'
  if (/^(refactor|move|extract|simplify)[: ]/.test(first)) return 'refactor'
  if (/^(feat|feature|add|support|introduce)[: ]/.test(first)) return 'feature'
  // `Layer: what changed` is the house style for anything that adds behaviour.
  if (/^[^:]{1,24}: /.test(first))
    return /^[^:]{1,24}: (fix|keep|stop|avoid|repair)\b/.test(first) ? 'fix' : 'feature'
  return 'unknown'
}

export const factsFromRange = (input: GitRangeInput): ReviewFacts => {
  const paths: string[] = []
  let insertions = 0
  let deletions = 0
  let deletedFiles = 0
  for (const line of input.numstat) {
    const [added, removed, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    paths.push(path)
    insertions += added === '-' ? 0 : Number(added) || 0
    deletions += removed === '-' ? 0 : Number(removed) || 0
  }
  if (paths.length === 0)
    for (const line of input.nameStatus) {
      const [, ...rest] = line.split('\t')
      if (rest.length) paths.push(rest[rest.length - 1])
    }

  let newFiles = 0
  let renamedFiles = 0
  for (const line of input.nameStatus) {
    const [status] = line.split('\t')
    if (status?.startsWith('R')) renamedFiles++
    if (status === 'A') newFiles++
    if (status === 'D') deletedFiles++
  }

  const areas = [...new Set(paths.map(areaOf))].toSorted()
  const extensions = [
    ...new Set(paths.map(extensionOf).filter((name): name is string => !!name)),
  ].toSorted()
  const testsChanged = paths.some(isTest)
  const testLines = input.numstat.reduce((sum, line) => {
    const [added, removed, ...rest] = line.split('\t')
    if (!isTest(rest.join('\t'))) return sum
    return sum + (Number(added) || 0) + (Number(removed) || 0)
  }, 0)
  const coreTouched = areas.some(
    (area) => area === 'core-server' || area === 'core-shared' || area === 'core-web',
  )
  const schemaTouched = paths.some((path) => schema.some((marker) => path.includes(marker)))
  const contractTouched = paths.some(
    (path) => /(^|\/)(api|refs)\.ts$/.test(path) || areaOf(path) === 'agents',
  )
  const dependencyTouched = paths.some(
    (path) =>
      path === 'package.json' || path.includes('pnpm-lock.yaml') || path === 'tsconfig.json',
  )
  const securityTouched = paths.some((path) => security.some((marker) => path.includes(marker)))
  const binTouched = paths.some((path) => path.startsWith('bin/'))
  const changeType = changeTypeOf(input.subjects, paths)

  return {
    id: input.id,
    base: input.base,
    head: input.head,
    commits: input.subjects.length,
    subjects: input.subjects,
    files: paths.length,
    insertions,
    deletions,
    newFiles,
    deletedFiles,
    renamedFiles,
    areas,
    extensions,
    testsChanged,
    testLines,
    coreTouched,
    schemaTouched,
    contractTouched,
    dependencyTouched,
    securityTouched,
    binTouched,
    changeType,
    validation: input.validation ?? 'unknown',
  }
}

/** Lines added plus removed: one number for "how big is this to review". */
export const delta = (facts: ReviewFacts): number => facts.insertions + facts.deletions
