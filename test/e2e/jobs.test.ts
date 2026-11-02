import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { beforeAll, expect, it } from 'vitest'
import { Committed } from '../../extensions/coding-tools/refs.ts'
import type { JobCard } from '../../extensions/jobs/types.ts'
import { groupAlive } from '../../lib/process-group.ts'
import { EventFeed } from '../../server/events.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, sourceCopy, temp, until } from '../helpers.ts'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) =>
  (await run('git', args, { cwd })).stdout.trim()

// One source copy for the whole file: every test gets its own home and user home, so nothing they check is shared.
let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp('ultimate-jobs-root-'))
})

type App = Awaited<ReturnType<typeof fauxServer>>

async function fixture() {
  const directory = await temp('ultimate-jobs-')
  const home = join(directory, 'home')
  const userHome = join(directory, 'user')
  const app = await fauxServer({ ultimateRoot, home, userHome })
  return { directory, home, userHome, app, folder: (id: string) => join(home, 'jobs', id) }
}

/**
 * A model that answers a `CALL { tool, args }` input with exactly that tool call, and anything else with a plain answer
 * — a second round, or the conversations extension's summary request — so each turn runs one call.
 */
function scripted(app: App) {
  const route: FauxResponseFactory = (transcript) => {
    app.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')
    if (
      last?.role !== 'user' ||
      typeof last.content !== 'string' ||
      !last.content.startsWith('CALL ')
    )
      return fauxAssistantMessage('Complete')
    const { tool, args } = JSON.parse(last.content.slice(5)) as {
      tool: string
      args: JsonObject
    }
    return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' })
  }
  app.host.faux!.setResponses([route])
}

/** One turn calling `tool` with `args` in the root conversation, and the text of the result it got back. */
async function call(app: App, tool: string, args: JsonObject) {
  const conversation = (await app.harness.conversation(app.root.id, context))!
  await (
    await conversation.submit(
      { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}` },
      context,
    )
  ).wait(context)
  const view = await conversation.viewState(context)
  try {
    const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
      ?.model?.[0]
    if (result?.role !== 'toolResult') throw new Error('Missing tool result')
    return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  } finally {
    view.dispose()
  }
}

/** One turn calling `background` with `args`. */
const job = (app: App, args: JsonObject) => call(app, 'background', args)

/** The finish cards written into the conversation that started the jobs. */
async function cards(app: App) {
  const conversation = (await app.harness.conversation(app.root.id, context))!
  return (await conversation.context(context)).entries.filter(
    (entry) => entry.kind === 'jobs.finished',
  )
}

/** The `coding-tools.committed` events the durable feed holds, oldest first. */
async function committed(app: App) {
  const feed = await app.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context)
  return (feed?.events ?? []).flatMap((event) => (Committed.is(event) ? [event] : []))
}

it('starts a job that outlives its call, and lists, logs and stops it', async () => {
  const { app, folder } = await fixture()
  scripted(app)
  try {
    const started = await job(app, {
      action: 'start',
      command: 'echo ready; echo more; sleep 30',
      label: 'bench',
    })
    expect(started.split('\n')[0]).toContain('J1 running')
    expect(started).toContain(join(folder('J1'), 'output.log'))
    const pid = Number(await readFile(join(folder('J1'), 'pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    // The call has returned and the group it started is still there.
    expect(groupAlive(pid)).toBe(true)

    const log = (id: string) => readFile(join(folder(id), 'output.log'), 'utf8').catch(() => '')
    await until(async () => (await log('J1')).includes('more'))
    expect(await job(app, { action: 'list' })).toContain('J1 running')
    expect(await job(app, { action: 'list' })).toContain(`(pid ${pid})`)
    expect((await job(app, { action: 'log', id: 'J1', lines: 1 })).split('\n')).toEqual([
      expect.stringContaining('J1 running'),
      'more',
    ])

    expect((await job(app, { action: 'stop', id: 'J1' })).split('\n')[0]).toContain('J1 stopped')
    await until(() => !groupAlive(pid))
    expect(groupAlive(pid)).toBe(false)
    // The stop is the one card of that job, and it says stopped rather than how the group's own exit looked.
    await until(async () => (await cards(app)).length === 1)
    expect((await cards(app))[0].data as JobCard).toMatchObject({
      id: 'J1',
      label: 'bench',
      state: 'stopped',
    })
  } finally {
    await app.close()
  }
})

it('writes one card when a job ends by itself, and a later stop writes none', async () => {
  const { app, folder } = await fixture()
  scripted(app)
  try {
    expect(await job(app, { action: 'start', command: 'exit 3' })).toContain('J1 running')
    await until(async () => (await cards(app)).length === 1)
    const [card] = await cards(app)
    expect(card.data as JobCard).toMatchObject({
      id: 'J1',
      conversation: app.root.id,
      command: 'exit 3',
      state: 'exited',
      exitCode: 3,
      log: join(folder('J1'), 'output.log'),
    })
    expect(card.data).not.toHaveProperty('unknown')
    expect(await job(app, { action: 'list' })).toContain('J1 exited 3')

    // A stop of a job that already ended reports how it ended and writes no second card.
    expect(await job(app, { action: 'stop', id: 'J1' })).toContain('J1 exited 3')
    expect(await cards(app)).toHaveLength(1)
  } finally {
    await app.close()
  }
})

it('adopts a job after a restart, while the bash group of the same conversation is gone', async () => {
  const directory = await temp('ultimate-jobs-restart-')
  const home = join(directory, 'home')
  const userHome = join(directory, 'user')
  const first = await fauxServer({ ultimateRoot, home, userHome })
  scripted(first)
  let closed = false
  const closeFirst = async () => {
    if (closed) return
    closed = true
    await first.close()
  }
  let second: App | undefined
  try {
    const bashPid = join(directory, 'bash.pid')
    await job(first, { action: 'start', command: 'sleep 60' })
    await call(first, 'bash', { command: `sleep 60 & echo $! > '${bashPid}'` })
    const jobPid = Number(await readFile(join(home, 'jobs', 'J1', 'pid'), 'utf8'))
    // The bash call's leftover went with its call; the job's group did not.
    const child = Number(await readFile(bashPid, 'utf8'))
    expect(groupAlive(child)).toBe(false)
    expect(groupAlive(jobPid)).toBe(true)

    await closeFirst()
    // Closing the harness stops no job.
    expect(groupAlive(jobPid)).toBe(true)

    second = await fauxServer({ ultimateRoot, home, userHome })
    scripted(second)
    expect(await job(second, { action: 'list' })).toContain('J1 running (completion unknown)')
    // Adoption never signals a job, and stop still ends it.
    expect(groupAlive(jobPid)).toBe(true)
    expect((await job(second, { action: 'stop', id: 'J1' })).split('\n')[0]).toContain('J1 stopped')
    await until(() => !groupAlive(jobPid))
    expect(groupAlive(jobPid)).toBe(false)
  } finally {
    await second?.close()
    await closeFirst()
  }
})

it('attributes the commits a job makes to the conversation that started it', async () => {
  const { app, directory } = await fixture()
  scripted(app)
  const repo = join(directory, 'repo')
  try {
    await mkdir(repo, { recursive: true })
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'config', 'user.name', 'Jobs Test')
    await git(repo, 'config', 'user.email', 'jobs@example.test')
    await job(app, {
      action: 'start',
      command: "git commit -q --allow-empty -m 'job work'",
      cwd: repo,
    })
    await until(async () => (await committed(app)).length === 1)
    const sha = await git(repo, 'rev-parse', 'HEAD')
    expect(await git(repo, 'log', '-1', '--format=%B')).toContain(
      `Ultimate-Conversation: ${app.root.id}`,
    )
    const emitted = (await committed(app)).filter((event) => event.data.sha === sha)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].data).toMatchObject({ conversation: app.root.id, subject: 'job work' })
    // Its card comes from the same end.
    await until(async () => (await cards(app)).length === 1)
  } finally {
    await app.close()
  }
})

it('records the end of a job whose leader died while nobody watched, once, and not again on the open after', async () => {
  const directory = await temp('ultimate-jobs-unwatched-')
  const home = join(directory, 'home')
  const userHome = join(directory, 'user')
  let app = await fauxServer({ ultimateRoot, home, userHome })
  scripted(app)
  const reopen = async () => {
    app = await fauxServer({ ultimateRoot, home, userHome })
    scripted(app)
    return app
  }
  try {
    await job(app, { action: 'start', command: 'sleep 60' })
    const pid = Number(await readFile(join(home, 'jobs', 'J1', 'pid'), 'utf8'))
    // The host closes as it would in a crash, dropping its listeners; then the job's leader is killed behind its back.
    await app.close()
    process.kill(-pid, 'SIGKILL')
    await until(() => !groupAlive(pid))

    const reopened = await reopen()
    expect(await job(reopened, { action: 'list' })).toContain('J1 exited')
    const card = (await cards(reopened))[0].data as JobCard
    // Nobody saw it exit: the card says so and carries no exit code it could not know.
    expect(card).toMatchObject({ id: 'J1', state: 'exited', unknown: true })
    expect(card).not.toHaveProperty('exitCode')

    // The card is written after the end is recorded, so the open that reports it marks it reported: the next open,
    // which re-announces every unreported end by design, writes nothing new.
    await reopened.close()
    const third = await reopen()
    expect(await cards(third)).toHaveLength(1)
  } finally {
    await app.close()
  }
})
