/**
 * The experiment's vocabulary: what a change looks like *before* it is reviewed, what the router decides,
 * and what evidence it can point at. Nothing here approves code or replaces a reviewer's finding — a
 * decision says which reviewers are worth starting, never what they will conclude.
 * See `docs/audit/review-routing.md`.
 */

/** The dimensions a review team runs today (`.ultimate/agents/reviewer-*.md`). */
export type Dimension = 'correctness' | 'architecture' | 'simplicity'

/** The routable dimensions: correctness is fixed on, so a router can only save on these two. */
export type Routable = Exclude<Dimension, 'correctness'>

export type ChangeType = 'docs' | 'fix' | 'feature' | 'refactor' | 'test' | 'unknown'

/** Where a change lands, as the repository's own layers name it (`AGENTS.md` "Layers"). */
export type Area =
  | 'core-server'
  | 'core-shared'
  | 'core-web'
  | 'lib'
  | 'extension'
  | 'project-extension'
  | 'agents'
  | 'skills'
  | 'docs'
  | 'test'
  | 'tooling'
  | 'other'

export type Validation = 'passed' | 'failed' | 'unknown'

/**
 * Everything a router may see about one work order. Every field is derived deterministically from git
 * and the workspace record — no model sees the diff, only these facts and the work order's own words.
 */
export type ReviewFacts = {
  /** Immutable case id: `wo-<conversation>-<head8>`. */
  id: string
  base: string
  head: string
  commits: number
  /** Commit subjects, oldest first, verbatim (no paths, no branch names). */
  subjects: string[]
  files: number
  insertions: number
  deletions: number
  newFiles: number
  deletedFiles: number
  renamedFiles: number
  areas: Area[]
  /** Extension folder names the change touched, e.g. `jobs`, `models`. */
  extensions: string[]
  testsChanged: boolean
  /** Lines added plus removed in `test/`. */
  testLines: number
  docsChanged: boolean
  /** `server/`, `shared/` or `web/src`: the layers that need the restart tool. */
  coreTouched: boolean
  /** A document kind, event, protocol or storage shape changed. */
  schemaTouched: boolean
  /** A facet contract changed: `api.ts`, `refs.ts`, an agent definition, a tool list. */
  contractTouched: boolean
  dependencyTouched: boolean
  /** Secrets, auth, exec/spawn, paths or env handling, an HTTP surface. */
  securityTouched: boolean
  /** `bin/`: only a human restart applies it. */
  binTouched: boolean
  changeType: ChangeType
  /** The lander's check results for this work order, when the record has them. */
  validation: Validation
  /** Free-form deterministic risk markers a rule can key on (`secrets`, `exec`, `migration`, …). */
  riskFlags: string[]
}

export type EvidenceSource = 'facts' | 'rule' | 'model' | 'override'

export type Evidence = { source: EvidenceSource; note: string }

/** One dimension's decision: whether to start that reviewer, why, and how sure the router is. */
export type DimensionDecision = {
  run: boolean
  /** Probability that this dimension has something worth reporting, 0..1. For correctness, 1. */
  probability: number
  evidence: Evidence[]
}

export type Decision = {
  /** Always present for every dimension, so a caller never has to guess a default. */
  dimensions: Record<Dimension, DimensionDecision>
  /** Security and durability scrutiny beyond the correctness pass (a flag, not an extra reviewer). */
  enhanced: DimensionDecision
  /** 0 = every routable dimension is far from its threshold, 1 = at it. */
  uncertainty: number
  /** Names of the deterministic overrides that forced the full team. Empty when none fired. */
  overrides: string[]
  /** `full-team` whenever any override fired or uncertainty crossed the abstain line. */
  mode: 'full-team' | 'routed'
  evidence: Evidence[]
}

/** A local model caller: given the facts, answer probabilities for the routable dimensions. */
export type ModelCaller = (facts: ReviewFacts, questions: ModelQuestion[]) => Promise<ModelAnswer[]>

export type ModelQuestion = { name: string; type: 'noul' | 'choice'; instructions: string }

/** One answer: a probability for `noul`, or a label plus probabilities for `choice`. */
export type ModelAnswer = {
  name: string
  type: 'noul' | 'choice'
  probability?: number
  choice?: string
  probabilities?: Record<string, number>
}

export type RouteOptions = {
  /** The local decision model. Absent means rules only (strategy B). */
  model?: ModelCaller
  /** Probabilities at or above these run that dimension. Calibrated on a train split, see the doc. */
  thresholds?: Partial<Record<Routable, number>>
  /** Above this uncertainty the router runs the whole team rather than guess (strategy E). */
  abstainAbove?: number
  /** `off` runs the model arm alone, overriding with nothing but a model failure (strategies C and D). */
  overrides?: 'on' | 'off'
}
