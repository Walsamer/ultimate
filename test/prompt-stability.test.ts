import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PromptInput } from '@earendil-works/pi-durable'
import { Jobs } from '../extensions/jobs/server.ts'
import { context } from '../server/harness.ts'
import { fauxServer, removeTemp, temp } from './helpers.ts'

/**
 * Every section the installed extensions render for one conversation, as the prompt gets them. A section returning
 * nothing is left out, as the prompt leaves it out.
 */
async function sections(server: Awaited<ReturnType<typeof fauxServer>>) {
  const agent = await server.root.agent(context)
  const input = {
    conversationId: server.root.id,
    agent,
    // The conversation's own cwd, as the harness builds it: there is no environment in a fixture.
    env: undefined,
    shown: {},
    read: server.harness,
  } as PromptInput
  const rendered: Record<string, string> = {}
  for (const extension of server.host.registry.snapshot().installed())
    for (const section of extension.sections ?? []) {
      const value = await section.render(input, context)
      if (value) rendered[section.key] = value
    }
  return rendered
}

it('renders the same sections a second apart while a job runs', async () => {
  const home = await temp()
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    // A job 19 seconds into its run, as the ledger holds it while the job prints.
    const startedAt = Date.now() - 19_000
    await server.harness.commit(async (tx) => {
      const ledger = await tx.doc(Jobs)
      ledger.next = 2
      ledger.jobs.J1 = {
        id: 'J1',
        command: 'pnpm bench',
        cwd: projectRoot,
        conversation: server.root.id,
        pid: 1234,
        startedAt,
        state: 'running',
      }
    }, context)

    // A later request a second after the first, without waiting for it.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(startedAt + 19_000)
    const first = await sections(server)
    vi.setSystemTime(startedAt + 20_000)
    const second = await sections(server)
    vi.useRealTimers()

    expect(first.background).toContain('J1 running')
    expect(Object.keys(first).length).toBeGreaterThan(10)
    // Named first, so a section that drifts is one line of failure rather than the whole prompt twice.
    expect(
      Object.keys({ ...first, ...second }).filter((key) => first[key] !== second[key]),
    ).toEqual([])
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  } finally {
    vi.useRealTimers()
    await server.close()
    await removeTemp(home)
  }
})
