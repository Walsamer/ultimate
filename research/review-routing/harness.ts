/**
 * The experiment: run every strategy over the committed dataset and report routing, recall and cost.
 *
 *   node research/review-routing/harness.ts              # needs 127.0.0.1:8765 (0.8B) and :8766 (2B v4)
 *   node research/review-routing/harness.ts --offline    # nothing listening: proves the abstention path
 *
 * Nothing here calls a paid provider. Reviewer costs are the ones this project already paid, read off the
 * `pi.usage` documents of the reviewers that ran (constants below); local inference is free and only its
 * latency is measured. Thresholds are fitted on the even-indexed half of the dataset and scored on the
 * odd-indexed half.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chosen, route } from '../../lib/review-routing/router.ts'
import { jevCaller } from '../../lib/review-routing/jev.ts'
import type {
  Decision,
  Dimension,
  ModelAnswer,
  ModelCaller,
  ReviewFacts,
  Routable,
} from '../../lib/review-routing/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const offline = process.argv.includes('--offline')

type Label = {
  ran: boolean
  actioned?: boolean
  maxPriority?: string
  verdict?: string
  note: string
  conversation?: number
}
type Case = {
  id: string
  conversation: number
  facts: ReviewFacts
  provenance: { range: string; checks: string; reviewers: number[] }
  labels?: Record<string, Label>
}

const cases = readFileSync(join(here, 'cases.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)

/**
 * Measured spend, USD, deepseek/deepseek-flash, from the `pi.usage` document of each reviewer this project
 * already ran: the two full teams (4005/4201/4223/4234 and 15240/15289/15311/15322) and one solo review
 * (23882). `LEAD` is the mean of the two review leads that ran a team. Nothing is re-run or re-priced.
 */
const measured = {
  source: 'pi.usage of conversations 4005, 4201, 4223, 4234, 15240, 15289, 15311, 15322, 23882',
  teamCost: { 'wo-3055-066f6a46': 0.3311, 'wo-13069-af91500a': 0.4338 },
  solo: 0.0882,
  perDimension: {
    correctness: [0.1013, 0.1806],
    architecture: [0.0338, 0.1081],
    simplicity: [0.0634, 0.1141],
  },
}
const LEAD = 0.082
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const dimCost = (dimension: Dimension) => mean(measured.perDimension[dimension])
const teamCost = (dims: readonly Dimension[]) =>
  LEAD + dims.reduce((sum, dimension) => sum + dimCost(dimension), 0)

const all: readonly Dimension[] = ['correctness', 'architecture', 'simplicity']

/** A model caller that remembers its answers (so calibration is arithmetic, not 700 requests) and gives up
 *  on a server that has already failed three times, the way a real caller would. */
const tracked = (caller: ModelCaller) => {
  const cache = new Map<string, ModelAnswer[]>()
  const latencies: number[] = []
  let failures = 0
  const call: ModelCaller = async (facts, questions) => {
    const hit = cache.get(facts.id)
    if (hit) return hit
    if (failures >= 3)
      throw new Error('local decision model unreachable (gave up after 3 failures)')
    const started = performance.now()
    try {
      const answers = await caller(facts, questions)
      latencies.push(performance.now() - started)
      cache.set(facts.id, answers)
      failures = 0
      return answers
    } catch (error) {
      failures++
      throw error
    }
  }
  return { call, latencies }
}

const model8b = tracked(
  jevCaller({ url: process.env.JEV_URL_08B ?? 'http://127.0.0.1:8765', timeoutMs: 15_000 }),
)
const model2b = tracked(
  jevCaller({ url: process.env.JEV_URL_2B ?? 'http://127.0.0.1:8766', timeoutMs: 20_000 }),
)

type Thresholds = Record<Routable, number>
const grid = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
const train = cases.filter((_item, index) => index % 2 === 0)
const test = cases.filter((_item, index) => index % 2 === 1)

const labelled = (items: Case[]) =>
  items.flatMap((item) =>
    Object.entries(item.labels ?? {})
      .filter(([, label]) => label.ran)
      .map(([dimension, label]) => ({
        item,
        dimension: dimension as Dimension,
        actioned: label.actioned === true,
      })),
  )

type Method = {
  name: string
  label: string
  options: (thresholds: Thresholds) => Parameters<typeof route>[1]
  needsModel: boolean
}

/** The hand-set pair a production plan would start from, reported beside the fitted numbers. */
const fixed: Thresholds = { architecture: 0.5, simplicity: 0.5 }

const methods: Method[] = [
  {
    name: 'B',
    label: 'deterministic rules only',
    needsModel: false,
    options: (thresholds) => ({ thresholds }),
  },
  {
    name: 'C',
    label: '0.8B v3, model alone',
    needsModel: true,
    options: (thresholds) => ({
      model: model8b.call,
      thresholds,
      overrides: 'off',
      abstainAbove: 2,
    }),
  },
  {
    name: 'D',
    label: '2B v4, model alone',
    needsModel: true,
    options: (thresholds) => ({
      model: model2b.call,
      thresholds,
      overrides: 'off',
      abstainAbove: 2,
    }),
  },
  {
    name: 'E8',
    label: 'hybrid: 0.8B + rules overrides + abstain',
    needsModel: true,
    options: (thresholds) => ({ model: model8b.call, thresholds, abstainAbove: 0.85 }),
  },
  {
    name: 'E2',
    label: 'hybrid: 2B v4 + rules overrides + abstain',
    needsModel: true,
    options: (thresholds) => ({ model: model2b.call, thresholds, abstainAbove: 0.85 }),
  },
  {
    name: 'F8',
    label: '0.8B + rules overrides, hand-set 0.5/0.5 threshold, no abstain',
    needsModel: true,
    options: () => ({ model: model8b.call, thresholds: fixed, overrides: 'on', abstainAbove: 2 }),
  },
  {
    name: 'F2',
    label: '2B v4 + rules overrides, hand-set 0.5/0.5 threshold, no abstain',
    needsModel: true,
    options: () => ({ model: model2b.call, thresholds: fixed, overrides: 'on', abstainAbove: 2 }),
  },
]

/** Fit on the train half: most actioned findings kept, then the fewest reviewer invocations. */
const calibrate = async (method: Method) => {
  const labels = labelled(train)
  const actioned = labels.filter((label) => label.actioned)
  let best: { thresholds: Thresholds; recall: number; runs: number } | undefined
  for (const architecture of grid)
    for (const simplicity of grid) {
      const thresholds = { architecture, simplicity }
      let hits = 0
      let runs = 0
      for (const { item, dimension, actioned: didAction } of labels) {
        const decision = await route(item.facts, method.options(thresholds))
        if (didAction && decision.dimensions[dimension].run) hits++
        runs += chosen(decision).length
      }
      const recall = actioned.length === 0 ? 1 : hits / actioned.length
      if (!best || recall > best.recall || (recall === best.recall && runs < best.runs))
        best = { thresholds, recall, runs }
    }
  return { ...best!, labelled: labels.length, actioned: actioned.length }
}

const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

const run = async () => {
  const strategies: {
    name: string
    label: string
    needsModel: boolean
    options: Parameters<typeof route>[1]
    thresholds: Thresholds | null
  }[] = [
    {
      name: 'A',
      label: 'baseline: the full team, as today',
      needsModel: false,
      options: {},
      thresholds: null,
    },
  ]
  const calibration: Record<string, unknown> = {}
  for (const method of methods) {
    const fit = method.name.startsWith('F') ? null : await calibrate(method)
    calibration[method.name] = fit ?? 'hand-set 0.5/0.5, no abstain'
    strategies.push({
      name: method.name,
      label: method.label,
      needsModel: method.needsModel,
      options: method.options(fit?.thresholds ?? fixed),
      thresholds: fit?.thresholds ?? fixed,
    })
  }

  const decisions: Record<string, unknown>[] = []
  const summary: Record<string, unknown>[] = []
  const runSets: Record<string, string[]> = {}

  for (const strategy of strategies) {
    const rows: {
      item: Case
      decision: Decision
      ran: Dimension[]
      latency: number
      cost: number
      missed: { dimension: string; note: string; conversation?: number }[]
    }[] = []
    for (const item of cases) {
      const started = performance.now()
      const decision =
        strategy.name === 'A'
          ? ({
              dimensions: {
                correctness: { run: true, probability: 1, evidence: [] },
                architecture: { run: true, probability: 1, evidence: [] },
                simplicity: { run: true, probability: 1, evidence: [] },
              },
              enhanced: { run: true, probability: 1, evidence: [] },
              uncertainty: 0,
              overrides: [],
              mode: 'full-team' as const,
              evidence: [],
            } satisfies Decision)
          : await route(item.facts, strategy.options)
      const latency = performance.now() - started
      const ran = chosen(decision)
      const missed = Object.entries(item.labels ?? {})
        .filter(
          ([dimension, label]) =>
            label.ran &&
            label.actioned === true &&
            !decision.dimensions[dimension as Dimension].run,
        )
        .map(([dimension, label]) => ({
          dimension,
          note: label.note,
          conversation: label.conversation,
        }))
      rows.push({ item, decision, ran, latency, cost: teamCost(ran), missed })
      decisions.push({
        case: item.id,
        strategy: strategy.name,
        ran,
        mode: decision.mode,
        overrides: decision.overrides,
        uncertainty: Number(decision.uncertainty.toFixed(3)),
        probabilities: {
          architecture: Number(decision.dimensions.architecture.probability.toFixed(3)),
          simplicity: Number(decision.dimensions.simplicity.probability.toFixed(3)),
          enhanced: Number(decision.enhanced.probability.toFixed(3)),
        },
        latencyMs: Number(latency.toFixed(1)),
        estimatedCost: Number(teamCost(ran).toFixed(4)),
        missed,
      })
    }
    runSets[strategy.name] = rows.map((row) => row.ran.join('+'))

    const heldOut = rows.filter((row) => test.some((item) => item.id === row.item.id))
    const heldOutLabels = labelled(heldOut.map((row) => row.item))
    const actioned = heldOutLabels.filter((label) => label.actioned)
    const caught = actioned.filter(
      (label) =>
        heldOut.find((row) => row.item.id === label.item.id)!.decision.dimensions[label.dimension]
          .run,
    )
    summary.push({
      strategy: strategy.name,
      label: strategy.label,
      thresholds: strategy.thresholds,
      calibration: calibration[strategy.name] ?? null,
      meanInvocations: Number(
        (rows.reduce((sum, row) => sum + row.ran.length, 0) / rows.length).toFixed(2),
      ),
      invocations: all.reduce(
        (counts, dimension) => ({
          ...counts,
          [dimension]: rows.filter((row) => row.ran.includes(dimension)).length,
        }),
        {} as Record<Dimension, number>,
      ),
      heldOutActioned: actioned.length,
      heldOutCaught: caught.length,
      heldOutRecall: actioned.length === 0 ? null : caught.length / actioned.length,
      missedActioned: rows.flatMap((row) =>
        row.missed.map((miss) => ({ case: row.item.id, ...miss })),
      ),
      estimatedCostPerWorkOrder: Number(mean(rows.map((row) => row.cost)).toFixed(4)),
      /** The brief's metric: spend over the labelled work orders whose every actioned dimension still ran. */
      costPerCorrectlyReviewed: (() => {
        const labelledRows = rows.filter((row) => row.item.labels)
        const correct = labelledRows.filter((row) => row.missed.length === 0)
        return correct.length === 0
          ? null
          : Number(
              (labelledRows.reduce((sum, row) => sum + row.cost, 0) / correct.length).toFixed(4),
            )
      })(),
      labelledWorkOrders: rows.filter((row) => row.item.labels).length,
      labelledCorrect: rows.filter((row) => row.item.labels && row.missed.length === 0).length,
      decidedByTheModelAlone: rows.filter((row) => row.decision.mode === 'routed').length,
      measuredBaselinePerWorkOrder: Number(mean(rows.map(() => teamCost(all))).toFixed(4)),
      latencyMs: strategy.needsModel
        ? {
            median: Number(
              percentile(
                strategy.name === 'D' || strategy.name === 'E2'
                  ? model2b.latencies
                  : model8b.latencies,
                0.5,
              ).toFixed(0),
            ),
            samples: (strategy.name === 'D' || strategy.name === 'E2' ? model2b : model8b).latencies
              .length,
          }
        : null,
      modelCalls: { 0.8: model8b.latencies.length, 2: model2b.latencies.length },
      abstained: rows.filter(
        (row) =>
          row.decision.overrides.includes('model-unavailable') ||
          row.decision.overrides.includes('uncertain'),
      ).length,
      modelUnavailable: rows.filter((row) => row.decision.overrides.includes('model-unavailable'))
        .length,
    })
  }

  const agreement = Object.fromEntries(
    Object.keys(runSets)
      .filter((name) => name !== 'A')
      .map((name) => [
        name,
        Number(
          (
            runSets[name].filter((set, index) => set === runSets.B[index]).length / cases.length
          ).toFixed(2),
        ),
      ]),
  )

  mkdirSync(join(here, 'results'), { recursive: true })
  const suffix = offline ? '-offline' : ''
  writeFileSync(
    join(here, 'results', `decisions${suffix}.json`),
    JSON.stringify(decisions, null, 2) + '\n',
  )
  writeFileSync(
    join(here, 'results', `summary${suffix}.json`),
    JSON.stringify(
      {
        measured,
        cases: cases.length,
        labelled: cases.filter((item) => item.labels).length,
        calibration,
        agreement,
        summary,
      },
      null,
      2,
    ) + '\n',
  )

  const lines = summary.map((row) => {
    const item = row as never as {
      strategy: string
      meanInvocations: number
      invocations: Record<Dimension, number>
      estimatedCostPerWorkOrder: number
      heldOutRecall: number | null
      missedActioned: unknown[]
      latencyMs: { median: number; samples: number } | null
      abstained: number
    }
    return `${item.strategy.padEnd(2)} | ${item.meanInvocations.toFixed(2)} | ${item.invocations.correctness}/${item.invocations.architecture}/${item.invocations.simplicity} | $${item.estimatedCostPerWorkOrder.toFixed(3)} | ${item.heldOutRecall === null ? 'n/a' : item.heldOutRecall.toFixed(2)} | ${item.missedActioned.length} | ${item.latencyMs ? `${item.latencyMs.median}ms n=${item.latencyMs.samples}` : '-'} | abstain ${item.abstained}`
  })
  console.log(
    'strategy | invocations/case | corr/arch/simp | cost/work order | held-out recall | missed actioned | local median | abstentions',
  )
  console.log(lines.join('\n'))
  console.log(
    `\n${cases.length} cases, ${cases.filter((item) => item.labels).length} labelled, ${labelled(cases).length} dimension labels (${labelled(cases).filter((label) => label.actioned).length} actioned)`,
  )
  console.log(`agreement with the rules' run set: ${JSON.stringify(agreement)}`)
  console.log(
    `local model calls: 0.8B ${model8b.latencies.length}, 2B ${model2b.latencies.length}${offline ? ' — OFFLINE RUN' : ''}`,
  )
}

await run()
