/**
 * The deterministic baseline (strategy B): plain arithmetic over pre-review facts, no model, no randomness.
 * It is also the safety floor of every other strategy — the overrides below force the whole team whatever a
 * model says, because a missed blocking finding costs more than every reviewer invocation this saves.
 */
import type { Evidence, ReviewFacts, Routable } from './types.ts'
import { delta } from './facts.ts'

export type RuleScore = { probability: number; evidence: Evidence[] }

export type RuleOutcome = {
  scores: Record<Routable, RuleScore>
  enhanced: RuleScore
  /** Names of overrides that force the full team. */
  overrides: string[]
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

/** Reasons no router may act on facts it does not have: a wrong guess here is a missed blocker. */
const forced = (facts: ReviewFacts): string[] => {
  const reasons: string[] = []
  if (facts.dependencyTouched) reasons.push('dependency')
  if (facts.schemaTouched) reasons.push('schema')
  if (facts.binTouched) reasons.push('supervisor')
  if (facts.validation === 'failed') reasons.push('checks-failed')
  if (facts.changeType === 'unknown') reasons.push('unknown-type')
  if (facts.files === 0) reasons.push('no-diff')
  if (delta(facts) > 600) reasons.push('large')
  return reasons
}

export const ruleOutcome = (facts: ReviewFacts): RuleOutcome => {
  const architecture = { probability: 0, evidence: [] as Evidence[] }
  const simplicity = { probability: 0, evidence: [] as Evidence[] }
  const enhanced = { probability: 0, evidence: [] as Evidence[] }
  const layers = facts.areas.filter(
    (area) =>
      area === 'core-server' || area === 'core-shared' || area === 'core-web' || area === 'lib',
  )
  const size = delta(facts)

  if (layers.length >= 2) {
    architecture.probability += 0.35
    architecture.evidence.push({ source: 'rule', note: `change crosses ${layers.join(' + ')}` })
  }
  if (facts.contractTouched) {
    architecture.probability += 0.3
    architecture.evidence.push({
      source: 'rule',
      note: 'a facet contract (api.ts, refs.ts or an agent) changed',
    })
  }
  if (facts.areas.includes('extension') || facts.areas.includes('project-extension')) {
    architecture.probability += 0.2
    architecture.evidence.push({
      source: 'rule',
      note: `touches extension(s) ${facts.extensions.join(', ') || '(unnamed)'}`,
    })
  }
  if (facts.renamedFiles > 0 || facts.deletedFiles > 0) {
    architecture.probability += 0.15
    const moves = [
      facts.renamedFiles > 0 ? `${facts.renamedFiles} moved or renamed` : '',
      facts.deletedFiles > 0 ? `${facts.deletedFiles} deleted` : '',
    ].filter(Boolean)
    architecture.evidence.push({ source: 'rule', note: `${moves.join(', ')} file(s)` })
  }
  if (facts.files >= 8) {
    architecture.probability += 0.1
    architecture.evidence.push({ source: 'rule', note: `${facts.files} files changed` })
  }

  if (size >= 400) {
    simplicity.probability += 0.4
    simplicity.evidence.push({
      source: 'rule',
      note: `+${facts.insertions}/-${facts.deletions} lines`,
    })
  } else if (size >= 200) {
    simplicity.probability += 0.2
    simplicity.evidence.push({
      source: 'rule',
      note: `+${facts.insertions}/-${facts.deletions} lines`,
    })
  }
  if (facts.newFiles >= 3) {
    simplicity.probability += 0.2
    simplicity.evidence.push({ source: 'rule', note: `${facts.newFiles} new files` })
  }
  if (!facts.testsChanged && size >= 100 && facts.changeType !== 'docs') {
    simplicity.probability += 0.2
    simplicity.evidence.push({ source: 'rule', note: 'behaviour changed with no test change' })
  }
  if (facts.renamedFiles > 0) {
    simplicity.probability += 0.1
    simplicity.evidence.push({ source: 'rule', note: `${facts.renamedFiles} rename(s) to judge` })
  }
  if (facts.changeType === 'docs') {
    simplicity.probability = 0
    simplicity.evidence = [
      { source: 'rule', note: 'docs-only change: nothing for the simplicity pass' },
    ]
  }

  if (facts.securityTouched) {
    enhanced.probability += 0.5
    enhanced.evidence.push({
      source: 'rule',
      note: 'secrets, process execution, paths or the HTTP surface changed',
    })
  }
  if (facts.schemaTouched) {
    enhanced.probability += 0.3
    enhanced.evidence.push({ source: 'rule', note: 'a stored document shape or protocol changed' })
  }
  if (facts.dependencyTouched) {
    enhanced.probability += 0.2
    enhanced.evidence.push({ source: 'rule', note: 'dependencies or a build config changed' })
  }

  return {
    scores: {
      architecture: {
        probability: clamp(architecture.probability),
        evidence: architecture.evidence,
      },
      simplicity: { probability: clamp(simplicity.probability), evidence: simplicity.evidence },
    },
    enhanced: { probability: clamp(enhanced.probability), evidence: enhanced.evidence },
    overrides: forced(facts),
  }
}
