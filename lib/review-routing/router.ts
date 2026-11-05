/**
 * The router: one pure decision about which reviewers are worth starting, and why.
 *
 * Invariants, in order of importance:
 * 1. The correctness pass is never routable. A small model may narrow advisory reviews; it must never
 *    stand in for the reasoning that decides whether a change is correct.
 * 2. A decision is not a verdict. Nothing here reads a finding, approves code or can override one; it only
 *    says which reviewers to start.
 * 3. When the facts or the model are not good enough, run the whole team. Abstaining is the cheap mistake.
 */
import { ruleOutcome } from './rules.ts'
import type {
  Decision,
  Dimension,
  DimensionDecision,
  Evidence,
  ReviewFacts,
  Routable,
  RouteOptions,
} from './types.ts'

/** Calibrated on the train split only; see `docs/audit/review-routing.md`. */
export const defaultThresholds: Record<Routable, number> = { architecture: 0.5, simplicity: 0.5 }

/** Above this the model is too close to a threshold to be trusted, and the whole team runs. */
export const defaultAbstainAbove = 0.85

const questions = [
  {
    name: 'architecture',
    type: 'noul' as const,
    instructions:
      "An architecture reviewer asks whether this change uses the codebase's own structure: existing seams, extensions instead of core, no second implementation beside an existing one, boundaries and facets respected. Would such a reviewer have something concrete to report about this work order?",
  },
  {
    name: 'simplicity',
    type: 'noul' as const,
    instructions:
      'A simplicity reviewer asks whether this change introduces speculative abstractions, duplication, dead code or slop, and whether its tests prove behaviour rather than restate the implementation. Would such a reviewer have something concrete to report about this work order?',
  },
  {
    name: 'enhanced',
    type: 'noul' as const,
    instructions:
      'Does this change need security or durability scrutiny beyond the ordinary correctness pass: secrets, authentication, process execution, path or input handling, stored state that must survive a crash, replay or double effects?',
  },
]

const decision = (run: boolean, probability: number, evidence: Evidence[]): DimensionDecision => ({
  run,
  probability,
  evidence,
})

/** The part no router may touch. */
const fixed = (): DimensionDecision =>
  decision(true, 1, [
    {
      source: 'override',
      note: 'fixed on: correctness is never routable, so a classifier cannot replace it',
    },
  ])

export const route = async (facts: ReviewFacts, options: RouteOptions = {}): Promise<Decision> => {
  const thresholds = { ...defaultThresholds, ...options.thresholds }
  const rules = ruleOutcome(facts)
  const forced = options.overrides === 'off' ? [] : rules.overrides
  const evidence: Evidence[] = []

  // A model that is down, slow or answers in an unexpected shape ends the question: run the team.
  let model: Record<string, number> | undefined
  if (options.model) {
    try {
      const answers = await options.model(facts, questions)
      model = {}
      for (const answer of answers) {
        if (answer.type === 'noul' && typeof answer.probability === 'number')
          model[answer.name] = answer.probability
      }
    } catch (error) {
      const note = `model unavailable (${error instanceof Error ? error.message : String(error)}): the whole team runs`
      const abstained = (probability: number): DimensionDecision =>
        decision(true, probability, [{ source: 'override', note }])
      return {
        dimensions: {
          correctness: fixed(),
          architecture: abstained(rules.scores.architecture.probability),
          simplicity: abstained(rules.scores.simplicity.probability),
        },
        enhanced: abstained(1),
        uncertainty: 1,
        overrides: [...forced, 'model-unavailable'],
        mode: 'full-team',
        evidence: [{ source: 'override', note }],
      }
    }
  }

  const probabilities: Record<Routable, number> = {
    architecture: model?.architecture ?? rules.scores.architecture.probability,
    simplicity: model?.simplicity ?? rules.scores.simplicity.probability,
  }

  const dimensions: Record<Routable, DimensionDecision> = {
    architecture: decision(
      probabilities.architecture >= thresholds.architecture,
      probabilities.architecture,
      [
        ...rules.scores.architecture.evidence,
        ...(model
          ? [{ source: 'model' as const, note: `p=${probabilities.architecture.toFixed(2)}` }]
          : []),
      ],
    ),
    simplicity: decision(
      probabilities.simplicity >= thresholds.simplicity,
      probabilities.simplicity,
      [
        ...rules.scores.simplicity.evidence,
        ...(model
          ? [{ source: 'model' as const, note: `p=${probabilities.simplicity.toFixed(2)}` }]
          : []),
      ],
    ),
  }

  // Distance from the decision boundary, per routable dimension: 1 means "right on it".
  const uncertainty = Math.max(
    ...(Object.keys(probabilities) as Routable[]).map((dimension) =>
      Math.max(0, 1 - Math.abs(probabilities[dimension] - thresholds[dimension])),
    ),
  )

  const abstain =
    options.model !== undefined && uncertainty >= (options.abstainAbove ?? defaultAbstainAbove)
  const enhancedProbability = rules.enhanced.probability
  const fullTeam = forced.length > 0 || abstain

  if (forced.length) evidence.push({ source: 'override', note: `forced by: ${forced.join(', ')}` })
  if (abstain)
    evidence.push({
      source: 'override',
      note: `too close to a threshold (uncertainty ${uncertainty.toFixed(2)}): the whole team runs`,
    })

  const run = (dimension: Routable): DimensionDecision =>
    fullTeam
      ? decision(true, dimensions[dimension].probability, dimensions[dimension].evidence)
      : dimensions[dimension]

  return {
    dimensions: {
      correctness: fixed(),
      architecture: run('architecture'),
      simplicity: run('simplicity'),
    },
    enhanced: decision(enhancedProbability >= 0.4, enhancedProbability, rules.enhanced.evidence),
    uncertainty,
    overrides: abstain ? [...forced, 'uncertain'] : forced,
    mode: fullTeam ? 'full-team' : 'routed',
    evidence,
  }
}

/** Which reviewers a decision starts, in team order — the one thing a caller acts on. */
export const chosen = (decided: Decision): Dimension[] =>
  (['correctness', 'architecture', 'simplicity'] as Dimension[]).filter(
    (dimension) => decided.dimensions[dimension].run,
  )
