import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { factsFromRange } from '../lib/review-routing/facts.ts'
import { askJev, JevError } from '../lib/review-routing/jev.ts'
import { ruleOutcome } from '../lib/review-routing/rules.ts'
import { chosen, route } from '../lib/review-routing/router.ts'
import type { ModelCaller, ReviewFacts } from '../lib/review-routing/types.ts'

const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  id: 'wo-test',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  commits: 1,
  subjects: ['Models: keep the switch back'],
  files: 4,
  insertions: 60,
  deletions: 10,
  newFiles: 1,
  deletedFiles: 0,
  renamedFiles: 0,
  areas: ['extension'],
  extensions: ['models'],
  testsChanged: true,
  testLines: 30,
  schemaTouched: false,
  contractTouched: false,
  dependencyTouched: false,
  securityTouched: false,
  binTouched: false,
  changeType: 'feature',
  validation: 'passed',
  ...over,
})

const answer =
  (architecture: number, simplicity: number, enhanced = 0.1): ModelCaller =>
  async () => [
    { name: 'architecture', probability: architecture },
    { name: 'simplicity', probability: simplicity },
    { name: 'enhanced', probability: enhanced },
  ]

describe('what a router may never do', () => {
  it('always runs correctness, whatever the facts and whatever the model says', async () => {
    const cases: ReviewFacts[] = [
      facts({ changeType: 'docs', areas: ['docs'], files: 1, insertions: 2, deletions: 0 }),
      facts(),
      facts({ insertions: 5000, deletions: 5000, files: 90, areas: ['core-server', 'core-web'] }),
      facts({ validation: 'unknown', changeType: 'unknown' }),
    ]
    for (const item of cases) {
      for (const caller of [undefined, answer(0, 0)]) {
        const decided = await route(item, { model: caller })
        expect(decided.dimensions.correctness.run).toBe(true)
        expect(chosen(decided)).toContain('correctness')
      }
    }
  })

  it('returns a decision about reviewers, never a verdict about the change', async () => {
    const decided = await route(facts(), { model: answer(0.9, 0.9) })
    expect(Object.keys(decided)).toEqual([
      'dimensions',
      'enhanced',
      'uncertainty',
      'overrides',
      'mode',
      'evidence',
    ])
    expect(JSON.stringify(decided)).not.toMatch(/approved|blocking|verdict/i)
  })

  it('keeps every probability a probability', async () => {
    const decided = await route(facts({ areas: ['core-server'], insertions: 300 }), {
      model: answer(0.62, 0.31),
    })
    for (const dimension of Object.values(decided.dimensions)) {
      expect(dimension.probability).toBeGreaterThanOrEqual(0)
      expect(dimension.probability).toBeLessThanOrEqual(1)
    }
    expect(decided.uncertainty).toBeGreaterThanOrEqual(0)
    expect(decided.uncertainty).toBeLessThanOrEqual(1)
  })
})

describe('the deterministic rules', () => {
  it('does not spend a simplicity pass on a docs-only change', async () => {
    const decided = await route(
      facts({ changeType: 'docs', areas: ['docs'], files: 2, insertions: 40, deletions: 2 }),
    )
    expect(decided.dimensions.simplicity.run).toBe(false)
    expect(chosen(decided)).toEqual(['correctness'])
  })

  it('notices a change that crosses layers and touches a contract', async () => {
    const decided = await route(
      facts({ areas: ['core-server', 'core-web', 'extension'], contractTouched: true, files: 9 }),
    )
    expect(decided.dimensions.architecture.run).toBe(true)
    expect(decided.dimensions.architecture.evidence.length).toBeGreaterThan(0)
  })

  it('forces the full team on each deterministic override', async () => {
    const triggers: [string, Partial<ReviewFacts>][] = [
      ['dependency', { dependencyTouched: true }],
      ['schema', { schemaTouched: true }],
      ['supervisor', { binTouched: true }],
      ['checks-failed', { validation: 'failed' }],
      ['unknown-type', { changeType: 'unknown' }],
      ['no-diff', { files: 0 }],
      ['large', { insertions: 500, deletions: 200 }],
    ]
    for (const [name, over] of triggers) {
      const outcome = ruleOutcome(facts(over))
      expect(outcome.overrides).toContain(name)
      // A model that would drop both advisory reviews must not get its way past an override.
      const decided = await route(facts(over), { model: answer(0, 0) })
      expect(decided.overrides).toContain(name)
      expect(decided.mode).toBe('full-team')
      expect(chosen(decided)).toEqual(['correctness', 'architecture', 'simplicity'])
    }
  })

  it('runs the bare model arm only when the overrides are switched off', async () => {
    const decided = await route(facts({ dependencyTouched: true }), {
      model: answer(0, 0),
      overrides: 'off',
    })
    expect(decided.mode).toBe('routed')
    expect(chosen(decided)).toEqual(['correctness'])
  })
})

describe('when the local model is not good enough', () => {
  it('runs the whole team when the model throws', async () => {
    const down: ModelCaller = async () => {
      throw new Error('local decision model at http://127.0.0.1:8765: TypeError: fetch failed')
    }
    const decided = await route(facts(), { model: down })
    expect(decided.mode).toBe('full-team')
    expect(decided.overrides).toContain('model-unavailable')
    expect(decided.uncertainty).toBe(1)
    expect(chosen(decided)).toEqual(['correctness', 'architecture', 'simplicity'])
  })

  it('runs the whole team when the model answers in a shape we did not ask for', async () => {
    const partial: ModelCaller = async () => [{ name: 'architecture', probability: 0.9 }]
    const decided = await route(facts(), { model: partial })
    expect(decided.mode).toBe('full-team')
    expect(decided.overrides).toContain('model-unavailable')
    expect(chosen(decided)).toEqual(['correctness', 'architecture', 'simplicity'])
    // Nothing the rules computed is dressed up as the model's answer.
    expect(decided.dimensions.architecture.evidence.every((item) => item.source !== 'model')).toBe(
      true,
    )
  })

  it('refuses a number that is not a probability instead of acting on it', async () => {
    for (const bad of [Number.NaN, -0.2, 1.5]) {
      const decided = await route(facts(), { model: answer(bad, 0.1) })
      expect(decided.mode).toBe('full-team')
      expect(decided.overrides).toContain('model-unavailable')
    }
  })

  it('abstains near a threshold instead of guessing', async () => {
    const decided = await route(facts(), {
      model: answer(0.5, 0.5),
      thresholds: { architecture: 0.5, simplicity: 0.5 },
    })
    expect(decided.uncertainty).toBe(1)
    expect(decided.overrides).toContain('uncertain')
    expect(chosen(decided)).toHaveLength(3)

    const clear = await route(facts(), {
      model: answer(0.95, 0.02),
      thresholds: { architecture: 0.5, simplicity: 0.5 },
    })
    expect(clear.mode).toBe('routed')
    expect(chosen(clear)).toEqual(['correctness', 'architecture'])
  })
})

describe('the security and durability advice', () => {
  it("takes the model's number when it is higher, and the rules' when it is not", async () => {
    const raised = await route(facts({ securityTouched: true }), {
      model: answer(0.9, 0.9, 0.95),
    })
    expect(raised.enhanced.probability).toBe(0.95)
    expect(raised.enhanced.run).toBe(true)

    // A small model does not get to overrule a path marker the rules saw: the advice may only be raised.
    const overruled = await route(facts({ securityTouched: true }), {
      model: answer(0.9, 0.9, 0.05),
    })
    expect(overruled.enhanced.probability).toBe(0.5)
    expect(overruled.enhanced.run).toBe(true)

    const rulesOnly = await route(facts({ securityTouched: true }))
    expect(rulesOnly.enhanced.probability).toBeGreaterThanOrEqual(0.5)
    expect(rulesOnly.enhanced.run).toBe(true)
    expect(rulesOnly.enhanced.evidence.length).toBeGreaterThan(0)

    const quiet = await route(facts())
    expect(quiet.enhanced.probability).toBe(0)
    expect(quiet.enhanced.run).toBe(false)
  })

  it('never invents advice for a change nobody flagged', async () => {
    const decided = await route(facts({ dependencyTouched: true }), { model: answer(0, 0, 0) })
    // The reviewers all run because of the override, and the advice stays at the rules' own number for a
    // dependency change: the model's zero cannot lower it below that, and nothing inflates it.
    expect(chosen(decided)).toHaveLength(3)
    expect(decided.enhanced.probability).toBe(0.2)
    expect(decided.enhanced.run).toBe(false)
  })
})

describe('the local model client', () => {
  const body =
    (payload: unknown, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })

  const questions = [
    { name: 'architecture', instructions: 'would an architecture pass have something to say?' },
    { name: 'simplicity', instructions: 'would a simplicity pass have something to say?' },
  ]

  it('reads a noul answer as a probability', async () => {
    const answers = await askJev(
      {
        url: 'http://127.0.0.1:8765',
        fetch: body({
          answers: {
            architecture: { type: 'noul', noul: 0.71 },
            simplicity: { type: 'noul', noul: 0.2 },
          },
        }),
      },
      'state',
      questions,
    )
    expect(answers).toEqual([
      { name: 'architecture', probability: 0.71 },
      { name: 'simplicity', probability: 0.2 },
    ])
  })

  it('refuses an answer that is not a probability', async () => {
    const bad = body({
      answers: {
        architecture: { type: 'noul', noul: 1.4 },
        simplicity: { type: 'noul', noul: 0.2 },
      },
    })
    await expect(
      askJev({ url: 'http://127.0.0.1:8765', fetch: bad }, 'state', questions),
    ).rejects.toBeInstanceOf(JevError)
  })

  it('refuses an answer it did not ask for, and a server error', async () => {
    const missing = body({ answers: { architecture: { type: 'noul', noul: 0.5 } } })
    await expect(
      askJev({ url: 'http://127.0.0.1:8765', fetch: missing }, 'state', questions),
    ).rejects.toThrow(/no answer/)
    await expect(
      askJev({ url: 'http://127.0.0.1:8765', fetch: body({}, 503) }, 'state', questions),
    ).rejects.toThrow(/HTTP 503/)
  })

  it('reports a timeout as a timeout, not as a decision', async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const error = await askJev(
      { url: 'http://127.0.0.1:8765', fetch: hanging, timeoutMs: 5 },
      'state',
      questions,
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(JevError)
    expect((error as JevError).kind).toBe('timeout')
  })
})

describe('pre-review facts', () => {
  it('derives the areas, the size and the test changes from git plumbing output alone', () => {
    const derived = factsFromRange({
      id: 'wo-test-cccccccc',
      base: 'a'.repeat(40),
      head: 'c'.repeat(40),
      subjects: ['Jobs: a finished job writes its card'],
      numstat: ['120\t4\tserver/owned-env.ts', '30\t0\ttest/jobs.test.ts', '-\t-\tdocs/logo.png'],
      nameStatus: ['M\tserver/owned-env.ts', 'A\ttest/jobs.test.ts', 'M\tdocs/logo.png'],
    })
    expect(derived.areas).toEqual(['core-server', 'docs', 'test'])
    expect(derived.testsChanged).toBe(true)
    expect(derived.insertions).toBe(150)
    expect(derived.deletions).toBe(4)
    expect(derived.newFiles).toBe(1)
    expect(derived.changeType).toBe('feature')
    expect(derived.files).toBe(3)
  })

  it('says "unknown" rather than guessing a type it cannot read', () => {
    const derived = factsFromRange({
      id: 'wo-test-cccccccc',
      base: 'a'.repeat(40),
      head: 'c'.repeat(40),
      subjects: ['Collapse large pastes into markers'],
      numstat: ['10\t1\tweb/src/app/composer.tsx'],
      nameStatus: ['M\tweb/src/app/composer.tsx'],
    })
    expect(derived.changeType).toBe('unknown')
    expect(ruleOutcome(derived).overrides).toContain('unknown-type')
  })
})

describe('the committed dataset', () => {
  const raw = readFileSync(
    join(import.meta.dirname, '..', 'research', 'review-routing', 'cases.jsonl'),
    'utf8',
  )
  const cases = raw
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string
          head: string
          base: string
          facts: ReviewFacts
          labels?: Record<string, { ran: boolean; actioned?: boolean }>
        },
    )

  it('is committed, immutable and free of host paths', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length)
    expect(raw).not.toMatch(/\/Users\/|\/Volumes\/|[A-Za-z]:\\/)
    for (const item of cases) {
      expect(item.id).toMatch(/^wo-\d+-[0-9a-f]{8}$/)
      expect(item.head).toMatch(/^[0-9a-f]{40}$/)
      expect(item.base).not.toBe(item.head)
      // One id per case, so a decision can be joined back to the work order it is about.
      expect(item.facts.id).toBe(item.id)
    }
  })

  it('labels a dimension only where a reviewer actually ran, and says whether it was actioned', () => {
    const labelled = cases.filter((item) => item.labels)
    expect(labelled.length).toBeGreaterThanOrEqual(3)
    for (const item of labelled) {
      for (const [dimension, label] of Object.entries(item.labels!)) {
        expect(['correctness', 'architecture', 'simplicity']).toContain(dimension)
        expect(label.ran || label.actioned === undefined).toBe(true)
      }
    }
    // Ground truth is sparse on purpose: 6 actioned findings across 7 dimension labels, and the rest unknown.
    const actioned = labelled.flatMap((item) =>
      Object.values(item.labels!).filter((label) => label.actioned),
    )
    expect(actioned.length).toBeGreaterThanOrEqual(6)
  })
})
