import { expect, it } from 'vitest'
import { guardWithin, timeout } from '../extensions/browser/server.ts'

/** A page operation Playwright never settles, like `evaluate`, which has no timeout of its own. */
const stuck = () => new Promise<never>(() => {})

it('says which budget ran out, in milliseconds and seconds', () => {
  const step = timeout(30_000, 'step')
  expect(step.message).toBe('step timed out after 30000 ms (30s)')
  expect(step.name).toBe('TimeoutError')
  expect(timeout(300_000, 'until').message).toBe('until timed out after 300000 ms (300s)')
  // The call's own budget was "timed out after 420s" alone, a number the caller never passed.
  expect(timeout(420_000, 'call').message).toBe('whole call timed out after 420000 ms (420s)')
})

it('reports the limit a step, an until wait and the whole call ran out of', async () => {
  await expect(guardWithin(5, 0).guard(stuck())).rejects.toThrow('step timed out after 5 ms')
  // An `until` step waits on top of the step's limit, and says so.
  await expect(guardWithin(5, 10).guard(stuck(), 10, 'until')).rejects.toThrow(
    'until timed out after 15 ms',
  )
  // What is left of the call, never the 120 s budget it was given.
  let now = 0
  const call = guardWithin(30_000, 0, () => now)
  now = 119_990
  await expect(call.guard(stuck())).rejects.toThrow('whole call timed out after 10 ms')
})
