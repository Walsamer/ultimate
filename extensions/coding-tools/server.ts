import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTool,
  InboxDoc,
  LiveDoc,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import { madeCommits, prepareBash } from '../../lib/commit-log.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { CancelAction, CancelledDoc, Committed } from './refs.ts'

/** Lets Pi's read tool shrink an image past the model's limits (2000x2000 by default) instead of refusing it. */
const images = await createNodePhotonImages()

/** Pi's edit tool, with how to recover from its two common failures. */
function editTool() {
  const edit = createEditTool()
  return {
    ...edit,
    description: `${edit.description} After "Could not find", read the region again before retrying; after "Found N occurrences", widen oldText with surrounding lines.`,
  }
}

function defaultBashTimeout() {
  const seconds = Number(process.env.ULTIMATE_BASH_TIMEOUT ?? 600)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('ULTIMATE_BASH_TIMEOUT must be a positive finite number of seconds')
  return seconds
}

const bashTripwireMessage = (seconds: number) =>
  `Tripwire: bash ran past the ${seconds} s default limit and was stopped. Pass timeout for longer commands.`

/** Why a command marked `interruptible` must not be cut mid-way, if it changes something; `undefined` when it only waits. */
export function changes(command: string) {
  // Bash joins backslash-newline continuations before it runs a line.
  const joined = command.replaceAll('\\\n', ' ')
  const end = '(?=$|[\\s;&|)])'
  return (
    new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+|-\\S+\\s+)*(push|commit|merge)${end}`).exec(
      joined,
    )?.[1] ??
    // A word of its own (npm install, composer install, artisan migrate:fresh), not part of a path or file name.
    new RegExp(`(?:^|[\\s;&|(])(install|migrate)(?=$|[\\s;&|):])`).exec(joined)?.[1]
  )
}

/**
 * The bash calls the user cancelled (`CancelAction`), by call id → when. Durable, so a call started before an extension
 * reload sees a cancel made after it. A restart ends a running call anyway: Pi recovers it as interrupted.
 */
const Cancelled = defineDoc<{ calls: Record<string, number> }>({
  kind: CancelledDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: {} }),
})
export const docs = [Cancelled]

/** `40s`, `5m 09s`, `2h 05m`. */
function took(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

/**
 * Run `run` until it finishes or is stopped, whichever comes first: by the user's cancel of this call, or, when
 * `interruptible`, by a steer queued in its conversation. A steer joins a run only after the tool round, so a wait would
 * otherwise hold it; ending the command here lets the run go on and the steer be placed at once. Follow-ups wait for the
 * run's end anyway, so they never interrupt. A stopped command is killed, and the call ends with the output so far and a
 * notice, as an ordinary result.
 */
async function untilStopped(
  run: (context: Context) => Promise<ToolExecutionResult>,
  api: ToolExecutionApi,
  interruptible: boolean | undefined,
  context: Context,
): Promise<ToolExecutionResult> {
  const id = api.conversationId
  // A watch needs the document to exist; created once per conversation.
  if (!(await api.snapshot(Cancelled, id, context)))
    await api.commit((tx) => tx.doc(Cancelled, id), context)
  const cancelled = (await api.watchDoc(Cancelled, id, context))!
  const inbox = interruptible ? await api.watchDoc(InboxDoc, id, context) : undefined
  const started = performance.now()
  const { context: command, cancel } = withCancel(context)
  let reason: string | undefined
  const stop = (why: string) => {
    if (reason) return
    reason = why
    cancel(new Error(why))
  }
  const inspectCancelled = (value: typeof cancelled.value) => {
    if (value?.calls[api.callId] !== undefined) stop('Cancelled by the user')
  }
  const inspectInbox = (value: NonNullable<typeof inbox>['value']) => {
    if (value?.items.some((item) => item.mode === 'steer'))
      stop('Interrupted by a steering message')
  }
  cancelled.start(async (value) => inspectCancelled(value))
  inbox?.start(async (value) => inspectInbox(value))
  try {
    inspectCancelled(cancelled.value)
    if (inbox) inspectInbox(inbox.value)
    return await run(command)
  } catch (error) {
    if (!reason || context.abortSignal?.aborted) throw error
    const retained = api.retainedOutput()
    // The notice goes last: long output keeps its tail, so a leading notice would be cut.
    return {
      output: [
        {
          type: 'text',
          text: `${retained.text || '(no output)'}\n[${reason} after ${took(performance.now() - started)}; the output above is the last the command printed.]`,
        },
      ],
      structuredOutput: { output: retained.text, truncated: retained.truncated, exitCode: 130 },
    }
  } finally {
    await Promise.all([cancelled.stop(), inbox?.stop()])
  }
}

export const userActions = ['cancel']
export const actions = {
  cancel: implementAction(CancelAction, async (args, { host, conversationId }) => {
    const callId =
      args && typeof args === 'object' && !Array.isArray(args) ? args.callId : undefined
    if (typeof callId !== 'string' || conversationId === undefined)
      throw new Error('Invalid bash call')
    const id = conversationId as ConversationId
    await host.harness().commit(async (tx) => {
      const live = await tx.doc(LiveDoc, id)
      const running = new Set(
        [...(live.tools ?? []), ...(live.nestedTools ?? [])].flatMap((slot) =>
          slot.name === 'bash' && slot.status === 'running' ? [slot.callId] : [],
        ),
      )
      if (!running.has(callId)) throw new Error('That bash call is not running')
      const calls = (await tx.doc(Cancelled, id)).calls
      // Calls never remove their own marks (one could land as a call ends); each cancel drops those of ended calls.
      for (const ended of Object.keys(calls)) if (!running.has(ended)) delete calls[ended]
      calls[callId] = Date.now()
    }, BACKGROUND_CONTEXT)
    return null
  }),
}

export default function codingTools(host: Pick<ExtensionHost, 'emit'>) {
  const shell = createBashTool()
  const parameters = Type.Object({
    ...shell.parameters.properties,
    interruptible: Type.Optional(
      Type.Boolean({
        description:
          'Only for commands that just wait or poll (CI checks, deploys, a file appearing): a steering message ends the command early. Never combine with commands that change things.',
      }),
    ),
  })
  // In the tool itself, not a wrap, so the events carry the call's trace and conversation.
  const bashTool = defineTool({
    ...shell,
    description: `${shell.description} Set interruptible for a command that only waits or polls, so a steering message can end it early.`,
    parameters,
    async execute({ interruptible, ...args }, api, context) {
      const change = interruptible ? changes(args.command) : undefined
      if (change)
        throw new Error(
          `An interruptible command must only wait, but this one changes things (${change}). Run the change in its own bash call, then wait in a separate interruptible one.`,
        )
      // One log per invocation: task ids repeat across projects and a retried call reruns its task.
      const log = join(tmpdir(), `ultimate-commits-${randomUUID()}.log`)
      const call = createBashTool({
        prepare: (execution) => prepareBash(execution, api, log),
      })
      const run = (command: Context) => call.execute(args, api, command)
      try {
        return await untilStopped(run, api, interruptible, context)
      } finally {
        // A failed or stopped command may still have committed, so record what it made either way.
        const commits = await madeCommits(log, api.conversationId)
        if (commits.length)
          await api
            .commit(async (tx) => {
              for (const commit of commits) await host.emit(tx, Committed, commit)
            }, context)
            .catch((error: unknown) =>
              // Recording is history only; the command's own result must stand.
              console.error('coding-tools: recording commits failed:', error),
            )
      }
    },
  })
  return defineExtension({
    name: 'coding-tools',
    // Each tool keeps its own parameters; the list is only read through the base registration.
    tools: [
      createReadTool({ images }),
      createWriteTool(),
      editTool(),
      bashTool,
    ] as ToolRegistration[],
    wraps: [
      wrapTool(createBashTool(), (bash) => ({
        ...bash,
        async execute(args, api, context) {
          if (args.timeout !== undefined) return bash.execute(args, api, context)
          const timeout = defaultBashTimeout()
          try {
            return await bash.execute({ ...args, timeout }, api, context)
          } catch (error) {
            if (
              error instanceof Error &&
              /^Command timed out after [\d.e+-]+ seconds$/.test(error.message)
            )
              throw new Error(bashTripwireMessage(timeout), { cause: error })
            throw error
          }
        },
      })),
    ],
  })
}
