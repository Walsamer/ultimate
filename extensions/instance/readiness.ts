/**
 * Waiting for a started instance to become ready: the child announces its URL on an `Ultimate: …` line and then
 * answers `/api/models`.
 *
 * Measured on this machine, timing `node server/main.ts` to that line and to the first `/api/models` answer, with the
 * home's Vite dep cache empty as it is for every preview (`cacheDir` is `<home>/vite`): 4.8 s for a bare project,
 * 3.8 s with a real worktree as the project, 8.1 s for three cold starts at once. Recorded preview starts under a
 * loaded machine took 42 s to succeed and were still bundling dependencies at 66 s. So the 60 s mark is where a wait
 * becomes worth reporting, not where it is over: while the child is alive and has not failed, the wait continues up to
 * `READY_GIVE_UP`, and a failure says what was waited for instead of looking like a dead instance.
 */
export const READY_REPORT = 60_000
/** The hard cap: five minutes, four and a half times the longest recorded start and fifty times the measured cold one. */
export const READY_GIVE_UP = 300_000
/** How often a wait still in progress says so, after the first report. */
export const READY_PROGRESS = 15_000
/** The last lines of the child's output a failure quotes. */
const TAIL_LINES = 15

export interface Readiness {
  /** The URL the child announced, or undefined while it has announced none. */
  url(): string | undefined
  /** Everything the child printed, oldest first. */
  output(): string
  /** Why the child is gone — it exited, was killed, or failed to spawn — or undefined while it runs. */
  ended(): string | undefined
  /** Whether the announced URL answers its API yet. A probe that throws counts as not yet. */
  responds(url: string): Promise<boolean>
  /** Milliseconds since the start began. */
  elapsed(): number
  /** Report progress to whoever waits on this start. */
  report(text: string): void
  /** Wait before the next attempt; rejects when the caller's signal aborts it. */
  pause(): Promise<void>
  /** The caller's abort signal, checked before every attempt so a stopped run leaves no wait behind. */
  signal?: AbortSignal
}

const seconds = (milliseconds: number) => Math.round(milliseconds / 1000)

/**
 * The error for a start that did not become ready: what it waited for, whether a URL was ever announced, how long the
 * wait took, and the last lines the child printed — the tail alone, never a wall of build output.
 */
export function readinessFailure(input: {
  elapsed: number
  url?: string
  ended?: string
  output: string
}): string {
  const announced = input.url
    ? `${input.url} announced but never answered /api/models`
    : 'no URL announced (the child printed no `Ultimate: <url>` line)'
  const state = input.ended ?? 'the child was still running'
  return `Instance did not become ready after ${seconds(input.elapsed)} s: ${announced}; ${state}. ${tail(input.output)}`
}

function tail(output: string): string {
  const lines = output.split('\n').filter((line) => line.trim())
  if (!lines.length) return 'It printed nothing.'
  const last = lines.slice(-TAIL_LINES)
  return `Last ${last.length} ${last.length === 1 ? 'line' : 'lines'} of its output:\n${last.join('\n').slice(-4000)}`
}

/**
 * Wait until the child answers its API, and return the URL it announced. Stops the moment the child is gone, the
 * caller aborts, or `READY_GIVE_UP` passes; reports progress from `READY_REPORT` on, so a slow start is visible rather
 * than silent.
 */
export async function waitForReady(wait: Readiness): Promise<string> {
  let nextReport = READY_REPORT
  for (;;) {
    wait.signal?.throwIfAborted()
    const url = wait.url()
    if (!wait.ended() && url && (await wait.responds(url))) return url
    wait.signal?.throwIfAborted()
    const ended = wait.ended()
    const elapsed = wait.elapsed()
    if (ended !== undefined || elapsed >= READY_GIVE_UP)
      throw new Error(readinessFailure({ elapsed, url, ended, output: wait.output() }))
    if (elapsed >= nextReport) {
      wait.report(
        url
          ? `Waiting for ${url} after ${seconds(elapsed)} s; it has not answered yet.`
          : `Still starting after ${seconds(elapsed)} s: no URL announced yet.`,
      )
      nextReport = elapsed + READY_PROGRESS
    }
    await wait.pause()
  }
}
