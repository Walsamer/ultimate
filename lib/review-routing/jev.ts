/**
 * The local decision model's client: `POST /v1/systemone` on loopback, the same request shape the
 * `classify` extension uses (`extensions/classify/README.md`) so a hosted Jev and this local server are
 * interchangeable. Failures are loud and typed — a router must abstain, never guess, when the model is
 * down, slow or answers in a shape we did not ask for.
 */
import type { ModelAnswer, ModelCaller, ModelQuestion, ReviewFacts } from './types.ts'

export class JevError extends Error {
  readonly kind: 'unreachable' | 'timeout' | 'response' | 'malformed'
  constructor(kind: JevError['kind'], message: string) {
    super(message)
    this.kind = kind
    this.name = 'JevError'
  }
}

export type JevOptions = {
  /** `http://127.0.0.1:8765` for the 0.8B, `:8766` for the 2B v4. */
  url: string
  /** Requests are one forward pass on a laptop; anything slower is a fault, not a decision. */
  timeoutMs?: number
  fetch?: typeof fetch
}

type SystemoneBody = {
  state: string
  questions: Record<string, { type: string; instructions: string }>
}

type SystemoneAnswer = {
  type: string
  noul?: number
  choice?: string
  confidence?: number
  probabilities?: Record<string, number>
}

/** Answers for the questions we asked, in the order we asked them, or a `JevError`. */
export const askJev = async (
  options: JevOptions,
  state: string,
  questions: ModelQuestion[],
  signal?: AbortSignal,
): Promise<ModelAnswer[]> => {
  const body: SystemoneBody = {
    state,
    questions: Object.fromEntries(
      questions.map((question) => [
        question.name,
        { type: question.type, instructions: question.instructions },
      ]),
    ),
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${options.url.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    const timedOut = combined.aborted && !signal?.aborted
    throw new JevError(
      timedOut ? 'timeout' : 'unreachable',
      `local decision model at ${options.url}: ${describeError(error)}`,
    )
  }
  if (!response.ok)
    throw new JevError('response', `local decision model answered HTTP ${response.status}`)

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new JevError(
      'malformed',
      `local decision model returned no JSON: ${describeError(error)}`,
    )
  }
  const answers = (payload as { answers?: Record<string, SystemoneAnswer> } | null)?.answers
  if (!answers || typeof answers !== 'object')
    throw new JevError('malformed', 'local decision model returned no answers')

  return questions.map((question) => {
    const answer = answers[question.name]
    if (!answer) throw new JevError('malformed', `no answer for question ${question.name}`)
    if (question.type === 'noul') {
      const probability = answer.noul
      if (
        typeof probability !== 'number' ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      )
        throw new JevError('malformed', `question ${question.name}: noul is not a probability`)
      return { name: question.name, type: 'noul' as const, probability }
    }
    if (typeof answer.choice !== 'string')
      throw new JevError('malformed', `question ${question.name}: choice missing`)
    return {
      name: question.name,
      type: 'choice' as const,
      choice: answer.choice,
      probabilities: answer.probabilities,
    }
  })
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/** A `ModelCaller` bound to one server: what `route()` takes, so tests can inject their own. */
export const jevCaller =
  (options: JevOptions): ModelCaller =>
  (facts, questions) =>
    askJev(options, describeFacts(facts), questions)

/** The state a model reads: the work order in words, never the diff and never a verdict. */
export const describeFacts = (facts: ReviewFacts): string => {
  const lines = [
    `Work order (${facts.changeType}): ${facts.subjects.join(' | ')}`,
    `${facts.commits} commit(s), ${facts.files} file(s), +${facts.insertions}/-${facts.deletions} lines, ${facts.newFiles} new, ${facts.renamedFiles} renamed.`,
    `Layers: ${facts.areas.join(', ') || 'none recorded'}.`,
  ]
  if (facts.extensions.length) lines.push(`Extensions: ${facts.extensions.join(', ')}.`)
  if (facts.contractTouched)
    lines.push('A facet contract (api.ts, refs.ts or an agent definition) changed.')
  if (facts.schemaTouched) lines.push('A stored document shape or a protocol changed.')
  if (facts.dependencyTouched) lines.push('Dependencies or a build config changed.')
  if (facts.securityTouched)
    lines.push('Code handling secrets, process execution, paths or the HTTP surface changed.')
  if (facts.binTouched) lines.push('The supervisor changed.')
  lines.push(facts.testsChanged ? `Tests changed (${facts.testLines} lines).` : 'No test changed.')
  lines.push(`The lander's checks for this work order: ${facts.validation}.`)
  return lines.join('\n')
}
