/**
 * Jobs: work that outlives the bash call that started it. Every shell an agent runs is a drained process group
 * (`server/owned-env.ts`), so a command's leftovers are stopped when its call returns and the call says so; the
 * `background` tool is the replacement for the work that deserves to keep running (a benchmark, a dev server, a
 * watcher). A job is its own process group whose pid, output and commit log live in `<home>/jobs/<id>/`, recorded in a
 * session ledger so `list`, `log` and `stop` find it, with one card to the conversation that started it when it ends.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable'
import type { BashExecution } from '@earendil-works/pi-durable/tools'
import type { ExtensionHost } from '../../server/extensions.ts'
import { madeCommits, prepareBash } from '../../lib/commit-log.ts'
import { groupAlive, readPidFile, spawnGroup, stopGroup } from '../../lib/process-group.ts'
import type { Group } from '../../lib/process-group.ts'
import { Committed } from '../coding-tools/api.ts'
import type { Job, JobCard, JobCardKind, Ledger } from './refs.ts'

const Jobs = defineDoc<Ledger>({
  kind: 'ultimate.jobs',
  scope: 'session',
  version: 1,
  checkpointWhen: () => false,
  initial: () => ({ next: 1, jobs: {}, calls: {} }),
})

/** The kind of the one passive entry a finished job writes, as `refs.ts` names it for the transcript card. */
const FINISHED: JobCardKind = 'jobs.finished'

const operations = ['start', 'list', 'log', 'stop'] as const

/** A job's log keeps the last 2001 lines, and no more than 256 KiB of them. */
function trimLog(text: string): string {
  const lines = text.split('\n').slice(-2001).join('\n')
  const bytes = Buffer.from(lines)
  return bytes.length > 256 * 1024 ? bytes.subarray(-256 * 1024).toString('utf8') : lines
}

/** `40s`, `5m 09s`, `2h 05m`: how long a job ran, or has been running. */
function lasted(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

/** How a job reads wherever it is reported: `J1 running · 3m: npm run bench (pid 1234)`. */
function line(job: Job, now = Date.now()) {
  const state =
    job.state === 'running'
      ? `running${job.adopted ? ' (completion unknown)' : ''}`
      : job.state === 'exited'
        ? job.exitCode === undefined
          ? 'exited'
          : `exited ${job.exitCode}`
        : 'stopped'
  const ran = lasted((job.endedAt ?? now) - job.startedAt)
  const first = job.command.trim().split('\n')[0]
  return `${job.id} ${state} · ${ran}: ${first}${job.pid ? ` (pid ${job.pid})` : ''}`
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

/** What a process keeps of a job it started: its group, and the queue its output is written through. */
type Watched = { group: Group; dir: string; queue: Promise<void> }

export default function jobs(host: ExtensionHost) {
  // Process state only, and reload-stable: the groups this process started and the queue their output runs through, so
  // a facet reload keeps writing a running job's log and a `stop` still holds its leader. The finish notification goes
  // with the facet (dropped in `onClose`); the next restart adopts the job as completion unknown.
  const shared = host.resource('jobs.groups', () => ({
    watched: new Map<string, Watched>(),
    starts: Promise.resolve(),
  }))
  /** The `close` listeners of this facet load, dropped when it closes. */
  const closers = new Set<() => void>()
  /** A job's folder: its pid file, its output log and its own commit log. */
  const folder = (id: string) => join(host.home, 'jobs', id)

  /** One start at a time: its id comes from the ledger and names its folder, so two cannot race for one id. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = shared.starts.then(work, work)
    shared.starts = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const card = (job: Job, endedAt: number, unknown?: true): JobCard => ({
    id: job.id,
    ...(job.label ? { label: job.label } : {}),
    command: job.command,
    cwd: job.cwd,
    conversation: job.conversation,
    ...(job.pid ? { pid: job.pid } : {}),
    startedAt: job.startedAt,
    endedAt,
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    state: job.state,
    log: join(folder(job.id), 'output.log'),
    ...(unknown ? { unknown: true as const } : {}),
  })

  /**
   * Report a job's end, once: its card as a passive entry in the conversation that started it, then the commits the job
   * made as lineage events. `madeCommits` takes its log with them, so this runs after nothing of the job is left.
   */
  async function announce(finished: JobCard) {
    const conversation = await host
      .harness()
      .conversation(finished.conversation as ConversationId, context)
    // A conversation that was concluded and cleared has nothing to show the card in; the job's files stay.
    if (conversation)
      await conversation.submit(
        {
          type: 'write',
          requestId: `jobs:finished:${finished.id}:${finished.endedAt}`,
          entry: { kind: FINISHED, data: finished },
        },
        context,
      )
    const commits = await madeCommits(
      join(folder(finished.id), 'commits.log'),
      finished.conversation,
    )
    if (!commits.length) return
    await host.harness().commit(async (tx) => {
      for (const commit of commits) await host.emit(tx, Committed, commit)
    }, context)
  }

  /**
   * A watched job's process group leader exited. In one commit: the exit, and unless it was reported already, the one
   * card. A job `stop` claimed, or one the ledger no longer holds, changes nothing.
   */
  async function finish(id: string, code: number | null) {
    const exited = await host.harness().commit(async (tx) => {
      const ledger = await tx.doc(Jobs)
      const job = ledger.jobs[id]
      if (!job || job.state !== 'running') return undefined
      const endedAt = (job.endedAt = Date.now())
      job.state = 'exited'
      if (code !== null) job.exitCode = code
      if (job.reported) return undefined
      job.reported = true
      return card(job, endedAt)
    }, context)
    if (exited) await announce(exited)
  }

  /** Append what a job printed and keep its log's tail; the job's own output listeners outlive a facet reload. */
  async function append(dir: string, chunk: string) {
    const path = join(dir, 'output.log')
    await appendFile(path, chunk)
    const output = await readFile(path, 'utf8')
    const trimmed = trimLog(output)
    if (trimmed !== output) await writeFile(path, trimmed)
  }

  /** The last `lines` lines of a job's log; empty before it printed anything. */
  async function tail(id: string, lines: number) {
    try {
      return (await readFile(join(folder(id), 'output.log'), 'utf8'))
        .trimEnd()
        .split('\n')
        .slice(-lines)
        .join('\n')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /** Start `args.command` as its own process group, record it in the ledger and follow it; never waits for it. */
  async function start(
    args: { command?: string; cwd?: string; label?: string },
    tool: ToolExecutionApi,
    caller: Context,
  ) {
    const command = required(args.command, 'command')
    const cwd = resolve(tool.env?.cwd ?? host.projectRoot, args.cwd ?? '.')
    const label = args.label?.trim()
    return serial(async () => {
      const known = await tool.snapshot(Jobs, caller)
      // A replayed start (the same call, run again after a crash) answers with the job it already started.
      const earlier = known?.calls[tool.callId]
      if (earlier && known?.jobs[earlier]) return line(known.jobs[earlier])
      const id = `J${known?.next ?? 1}`
      const dir = folder(id)
      await mkdir(dir, { recursive: true })
      // The job's commits are its own: never the bash call's environment, whose log file goes when the call returns.
      const execution: BashExecution = { command, cwd, env: {}, inheritEnv: true }
      prepareBash(execution, tool, join(dir, 'commits.log'))
      const program = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
      const group = spawnGroup(program, ['-c', command], {
        cwd,
        env: { ...process.env, ...execution.env },
        pidFile: join(dir, 'pid'),
      })
      const pid = group.child.pid
      if (pid === undefined) throw new Error(`Cannot start ${program} for job ${id}`)
      const job: Job = {
        id,
        command,
        cwd,
        conversation: tool.conversationId,
        pid,
        startedAt: Date.now(),
        state: 'running',
        ...(label ? { label } : {}),
      }
      let saved: Job
      try {
        saved = await tool.commit(async (tx) => {
          const ledger = await tx.doc(Jobs)
          // Another process sharing this home took the id: nothing may be recorded under one it does not own.
          if (ledger.next !== Number(id.slice(1)))
            throw new Error(`Job ${id} was taken by another start; try again`)
          ledger.next = Number(id.slice(1)) + 1
          ledger.jobs[id] = job
          ledger.calls[tool.callId] = id
          return { ...job }
        }, caller)
      } catch (error) {
        // A start the ledger would not record leaves no group behind.
        await stopGroup(pid, { pidFile: join(dir, 'pid'), leader: group }).catch(
          (failure: unknown) => host.notice(`Jobs: stopping unrecorded ${id}: ${String(failure)}`),
        )
        throw error
      }
      const watched: Watched = { group, dir, queue: Promise.resolve() }
      for (const stream of [group.child.stdout, group.child.stderr]) {
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          watched.queue = watched.queue
            .then(() => append(dir, chunk))
            // Nothing left to tell it to: the log write has no reader, and the job itself keeps running.
            .catch((error: unknown) => console.error(`jobs: writing ${id}'s log:`, error))
        })
      }
      shared.watched.set(id, watched)
      const closed = (code: number | null) => {
        closers.delete(off)
        shared.watched.delete(id)
        watched.queue
          .then(() => finish(id, code))
          .catch((error: unknown) => host.notice(`Jobs: ${id}: ${String(error)}`))
      }
      const off = () => group.child.off('close', closed)
      group.child.once('close', closed)
      closers.add(off)
      return `${line(saved)}\nLog: ${join(dir, 'output.log')}`
    })
  }

  /** Stop the whole group of a running job, with its card and the commits it made; a job that ended says so. */
  async function stop(job: Job, tool: ToolExecutionApi, caller: Context) {
    // Claimed before the signal, so the group's own exit is not reported as a completion nobody asked for.
    const claimed = await host.harness().commit(async (tx) => {
      const ledger = await tx.doc(Jobs)
      const running = ledger.jobs[job.id]
      if (!running || running.state !== 'running') return undefined
      const endedAt = (running.endedAt = Date.now())
      running.state = 'stopped'
      if (running.reported) return undefined
      running.reported = true
      return card(running, endedAt)
    }, caller)
    if (!claimed) {
      const state = await tool.snapshot(Jobs, caller)
      const ended = state?.jobs[job.id]
      if (!ended) throw new Error(`Unknown job: ${job.id}`)
      return line(ended)
    }
    try {
      const leader = shared.watched.get(job.id)
      if (claimed.pid)
        await stopGroup(claimed.pid, {
          pidFile: join(folder(job.id), 'pid'),
          ...(leader ? { leader: leader.group } : {}),
        })
    } finally {
      shared.watched.delete(job.id)
      // The card goes out even when a group would not die: the job is no longer watched either way.
      await announce(claimed)
    }
    return line({ ...job, state: 'stopped', endedAt: claimed.endedAt })
  }

  /** A job `id` from the ledger, or an error for an id it does not hold. */
  function find(ledger: Readonly<Ledger> | undefined, id: string): Job {
    const job = ledger?.jobs[id]
    if (!job) throw new Error(`Unknown job: ${id}`)
    return job
  }

  host.onOpen(async () => {
    const ledger = await host.harness().snapshot(Jobs, context)
    const running = Object.values(ledger?.jobs ?? {}).filter((job) => job.state === 'running')
    if (!running.length) return
    // Nothing of this process watches them: a restart, or a facet reload that dropped the finish listeners. The pid file
    // and the group tell a job that still runs from one whose leader went while nobody watched.
    const found: { id: string; alive: boolean }[] = []
    for (const job of running)
      found.push({
        id: job.id,
        alive:
          job.pid !== undefined &&
          (await readPidFile(join(folder(job.id), 'pid'))) === job.pid &&
          groupAlive(job.pid),
      })
    const ended = await host.harness().commit(async (tx) => {
      const state = await tx.doc(Jobs)
      const cards: JobCard[] = []
      for (const { id, alive } of found) {
        const job = state.jobs[id]
        if (!job || job.state !== 'running') continue
        if (alive) {
          // Left alone, never signalled or rerun: it runs, but nobody watched how it ends.
          job.adopted = true
          continue
        }
        const endedAt = (job.endedAt = Date.now())
        job.state = 'exited'
        if (job.reported) continue
        job.reported = true
        cards.push(card(job, endedAt, true))
      }
      return cards
    }, context)
    for (const finished of ended) await announce(finished)
  })

  // A job is not this facet's to stop: an ordinary bash call's group dies with its call, a job's does not. Only the
  // listeners of this facet load go, so the next open adopts its running jobs as completion unknown.
  host.onClose(async () => {
    for (const off of closers) off()
    closers.clear()
  })

  return defineExtension({
    name: 'jobs',
    sections: [
      section('background', async ({ read }, caller) => {
        const ledger = await read.snapshot(Jobs, caller)
        const running = Object.values(ledger?.jobs ?? {}).filter((job) => job.state === 'running')
        // Always rendered: a section that disappears and reappears reorders the prompt, which rebuilds it whole.
        return running.length ? running.map((job) => line(job)).join('\n') : 'None running.'
      }),
    ],
    tools: [
      defineTool({
        name: 'background',
        // A replayed start answers from the ledger's `calls` receipt, so a crash never starts a second copy of a job.
        replay: 'safe',
        // Calls in one round apply in the order written: a start is recorded before the log or stop that follows it.
        executionMode: 'sequential',
        description:
          'Run work that outlives the call: a benchmark, a dev server, a watcher. bash stops what its command leaves running when the call returns; a job keeps running as its own process group, with its pid, its output log and the commits it makes, and its end writes one card to this conversation. start {command, cwd?, label?} returns the job id, pid and log path and never waits for it. list shows every job with its state, pid and duration. log {id, lines?} reads the end of its output (default 50 lines, at most 2000). stop {id} stops its whole group, idempotently. Ids are J1, J2, … A job outlives the call and a restart: adopted after one, it shows as "completion unknown" and is never signalled or rerun by itself.',
        parameters: Type.Object({
          action: Type.Union(operations.map((value) => Type.Literal(value))),
          command: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
          id: Type.Optional(Type.String()),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
        }),
        execute: async (args, tool, caller) => {
          let text: string
          if (args.action === 'start') text = await start(args, tool, caller)
          else if (args.action === 'list') {
            const ledger = await tool.snapshot(Jobs, caller)
            const all = Object.values(ledger?.jobs ?? {})
            text = all.length ? all.map((job) => line(job)).join('\n') : 'No jobs.'
          } else {
            const job = find(await tool.snapshot(Jobs, caller), required(args.id, 'id'))
            if (args.action === 'log') {
              const output = await tail(job.id, args.lines ?? 50)
              text = `${line(job)}${output ? `\n${output}` : '\n(no output yet)'}`
            } else text = await stop(job, tool, caller)
          }
          return { output: [{ type: 'text' as const, text }] }
        },
      }),
    ],
  })
}
