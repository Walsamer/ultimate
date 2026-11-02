// Every shell an agent runs goes through here instead of straight through Pi's own env: a command becomes a recorded
// process group (`lib/process-group.ts`), so a crash leaves a pid file to sweep, and when its leader exits the rest of
// the group is stopped rather than outliving the call with nothing able to find it again. The count it had to stop is
// what the bash tool turns into a diagnostic, which is how the model learns to use the `background` tool for work that
// deserves to outlive a call.
//
// Pi upstream: @earendil-works/pi-durable@1.4.0 src/env/node.ts — `exec` forks Pi's NodeExecutionEnv.exec. The
// contract it keeps: a string runs through the shell (its shell choice, unexported there), an array runs its program
// directly, env merging with `inheritEnv`, a cwd resolved against `this.cwd`, `timeout` in seconds, abort through the
// context's signal, the exit code (128 + signal number when a signal ended it), `spawn_error`/`timeout`/`aborted`
// failures, `onOutput` per decoded chunk, and a spill file past the caller's thresholds. What differs is that the
// command is a drained process group, and that no output is omitted for `window`: this env is local and cheap, which
// is also what Pi's own local env does. Recheck this fork when Pi changes exec; `test/e2e/owned-env.test.ts` compares it
// with NodeExecutionEnv. `cleanup` is Pi's too, extended to every group this env started.
import { accessSync, closeSync, constants, mkdtempSync, openSync, writeSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { constants as osConstants, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { err, ExecutionError, ok } from '@earendil-works/pi-durable/env'
import type { Result, ShellExecOptions, ShellExecResult } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { closeOutput, spawnGroup, stopGroup } from '../lib/process-group.ts'
import { SHELL_CALL } from '../shared/shell-call.ts'
import type { Group } from '../lib/process-group.ts'

const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * What shell calls left running, by the call id their execution carried in `SHELL_CALL` (shared/shell-call.ts): how many
 * processes the group still had when its leader exited and the drain stopped them. The bash tool reads its own count once.
 */
const stopped = new Map<string, number>()

/** How many processes shell call `id` left running, and stopped; 0 when it left none. Read once, then forgotten. */
export function shellLeftovers(id: string) {
  const count = stopped.get(id) ?? 0
  stopped.delete(id)
  return count
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The spill Pi's exec promises: past `afterBytes` or `afterLines` the whole output, prefix included, goes to a temp
 * file whose path the result reports, so a command's complete output outlives the retained tail. Chunks arrive from the
 * child's data events and are written as they come, blocking for the microseconds a local write takes, so nothing
 * queues in memory and no stream needs pausing.
 */
class Spill {
  private readonly prefix: string[] = []
  private readonly limits: { afterBytes: number; afterLines: number }
  private bytes = 0
  private newlines = 0
  private fd: number | undefined
  private failed: ((error: unknown) => void) | undefined
  /** The file the whole output went to, once the thresholds were crossed. */
  path: string | undefined

  constructor(
    limits: { afterBytes: number; afterLines: number },
    failed: (error: unknown) => void,
  ) {
    this.limits = limits
    this.failed = failed
  }

  /** `chunk` exactly as it arrived. Once the file exists it goes straight there. */
  push(chunk: string) {
    if (chunk === '') return
    if (this.fd !== undefined) {
      this.write(chunk)
      return
    }
    this.bytes += Buffer.byteLength(chunk)
    for (let index = chunk.indexOf('\n'); index !== -1; index = chunk.indexOf('\n', index + 1))
      this.newlines++
    // A chunk that does not end in a newline has started one more line, as Pi counts it.
    const lines = this.newlines + (chunk.endsWith('\n') ? 0 : 1)
    this.prefix.push(chunk)
    if (this.bytes <= this.limits.afterBytes && lines <= this.limits.afterLines) return
    try {
      this.path = join(
        mkdtempSync(join(tmpdir(), 'ultimate-spill-')),
        `pi-output-${randomUUID()}.log`,
      )
      this.fd = openSync(this.path, 'a')
    } catch (error) {
      this.fail(error)
      return
    }
    for (const earlier of this.prefix) this.write(earlier)
    this.prefix.length = 0
  }

  /** Close the file; the run is over. */
  finish() {
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
    } catch (error) {
      // A close that fails after every chunk was written changes nothing the caller reports; the file is complete.
      void error
    }
    this.fd = undefined
  }

  private write(chunk: string) {
    try {
      writeSync(this.fd!, chunk)
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown) {
    const failure = this.failed
    if (!failure) return
    this.failed = undefined
    failure(error)
  }
}

/**
 * Pi's execution env, with every shell owned: a command runs as a pid-recorded process group, nothing of it outlives
 * its leader, and `cleanup` stops the groups it started. Windows keeps Pi's exec: the group machinery is POSIX only.
 */
export class OwnedExecutionEnv extends NodeExecutionEnv {
  /** Where each call records its group's pid, so a crash leaves something to sweep. */
  readonly shellDir: string
  private readonly configuredShell: string | undefined
  private readonly inheritedEnv: NodeJS.ProcessEnv | undefined
  private readonly running = new Set<{ group: Group; pidFile: string }>()
  /** The shell directory, created once: each call's pid file goes there. */
  private created: Promise<unknown> | undefined

  constructor(options: ConstructorParameters<typeof NodeExecutionEnv>[0] & { shellDir: string }) {
    super(options)
    this.configuredShell = options.shellPath
    this.inheritedEnv = options.shellEnv
    this.shellDir = options.shellDir
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (process.platform === 'win32') return super.exec(command, options, context)
    const signal = context.abortSignal
    if (signal?.aborted) return err(new ExecutionError('aborted', 'aborted'))
    const seconds = options?.timeout
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0))
      return err(
        new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'),
      )
    const timed = seconds === undefined ? undefined : seconds * 1000
    if (timed !== undefined && timed > MAX_TIMEOUT_MS)
      return err(
        new ExecutionError(
          'timeout',
          `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`,
        ),
      )
    const directory = await this.absolutePath(options?.cwd ?? '.', context)
    if (!directory.ok) return err(new ExecutionError('spawn_error', directory.error.message))
    const cwd = directory.value
    let program: string
    let args: string[]
    if (typeof command === 'string') {
      const shell = this.shell()
      if (shell === undefined)
        return err(
          new ExecutionError(
            'shell_unavailable',
            `Custom shell path not found: ${this.configuredShell}`,
          ),
        )
      program = shell
      args = ['-c', command]
    } else {
      const [first, ...rest] = command
      if (first === undefined)
        return err(new ExecutionError('spawn_error', 'Empty argv: no program to run'))
      program = first
      args = rest
    }
    try {
      accessSync(cwd, constants.F_OK)
    } catch (error) {
      return err(
        new ExecutionError(
          'spawn_error',
          `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
          error instanceof Error ? error : undefined,
        ),
      )
    }
    const env: NodeJS.ProcessEnv =
      options?.inheritEnv === false
        ? { ...options.env }
        : { ...process.env, ...this.inheritedEnv, ...options?.env }
    // The bash tool names the call it is running here; the command itself never sees it.
    const call = env[SHELL_CALL]
    delete env[SHELL_CALL]
    this.created ??= mkdir(this.shellDir, { recursive: true })
    try {
      await this.created
    } catch (error) {
      return err(
        new ExecutionError(
          'spawn_error',
          message(error),
          error instanceof Error ? error : undefined,
        ),
      )
    }
    const pidFile = join(this.shellDir, `${randomUUID()}.pid`)
    const started = await this.start(program, args, { cwd, env, pidFile })
    if (!started.ok) return started
    const group = started.value
    const { child } = group
    const entry = { group, pidFile }
    this.running.add(entry)
    let timedOut = false
    let callbackError: ExecutionError | undefined
    let spillError: ExecutionError | undefined
    const spill: Spill | undefined = options?.spill
      ? new Spill(options.spill, (error) => {
          spillError ??= new ExecutionError(
            'unknown',
            `Failed to preserve complete shell output: ${message(error)}`,
          )
          halt()
        })
      : undefined
    const emit = (text: string, stream: 'stdout' | 'stderr') => {
      // Nothing reaches the caller after the run settled, nor after a failed callback or spill.
      if (text === '' || callbackError || spillError) return
      try {
        options?.onOutput?.(text, context, { stream })
      } catch (error) {
        callbackError = new ExecutionError('callback_error', message(error))
        halt()
      }
    }
    for (const [stream, name] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ] as const) {
      // One decoder per stream, so a character split across chunks of one stream survives interleaving.
      stream.setEncoding('utf8')
      stream.on('data', (text: string) => {
        emit(text, name)
        spill?.push(text)
      })
    }
    const exited = new Promise<number>((resolve) => {
      child.once('error', (error) => {
        callbackError ??= new ExecutionError('spawn_error', error.message, error)
        resolve(1)
      })
      child.once('exit', (code, name) =>
        resolve(code ?? (name ? 128 + (osConstants.signals[name] ?? 0) : 1)),
      )
    })
    const stalled = Promise.withResolvers<never>()
    function halt() {
      if (child.pid === undefined) return
      // A stop that fails ends the run at once instead of waiting for an exit that will not come.
      stopGroup(child.pid, { pidFile, leader: group }).catch((error: unknown) =>
        stalled.reject(error),
      )
    }
    const timer =
      timed === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            halt()
          }, timed)
    const onAbort = () => halt()
    signal?.addEventListener('abort', onAbort, { once: true })
    // An abort that arrived while this exec was getting ready, before the listener existed.
    if (signal?.aborted) halt()
    let stoppedCount = 0
    try {
      const code = await Promise.race([exited, stalled.promise])
      // The leader is reaped; the group's own drain stops what it left, and nothing of it outlives the call.
      stoppedCount = (await group.ended).stopped
      spill?.finish()
      await closeOutput(group)
      if (callbackError) return err(callbackError)
      if (spillError) return err(spillError)
      if (timedOut)
        return err(withSpill(new ExecutionError('timeout', `timeout:${options?.timeout}`), spill))
      if (signal?.aborted) return err(withSpill(new ExecutionError('aborted', 'aborted'), spill))
      return ok({ exitCode: code, ...(spill?.path === undefined ? {} : { spillPath: spill.path }) })
    } catch (error) {
      spill?.finish()
      await closeOutput(group)
      return err(new ExecutionError('unknown', message(error)))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // The pid file goes with the group: a sweep of a later start finds nothing of this call.
      await stopGroup(child.pid!, { pidFile, leader: group }).catch(
        // A group that survives its own drain was reported above; removing its file must not fail the call twice.
        () => undefined,
      )
      this.running.delete(entry)
      if (call !== undefined) stopped.set(call, (stopped.get(call) ?? 0) + stoppedCount)
    }
  }

  /** Pi's own shell choice, POSIX side: the configured shell, else bash, else sh (unexported getShellConfig). */
  private shell() {
    if (this.configuredShell !== undefined)
      return exists(this.configuredShell) ? this.configuredShell : undefined
    return exists('/bin/bash') ? '/bin/bash' : 'sh'
  }

  /** Start the group, or say why it could not start. */
  private async start(
    program: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; pidFile: string },
  ): Promise<Result<Group, ExecutionError>> {
    try {
      const group = spawnGroup(program, args, options)
      if (group.child.pid === undefined)
        return err(new ExecutionError('spawn_error', `Cannot start ${program}`))
      return ok(group)
    } catch (error) {
      return err(
        new ExecutionError(
          'spawn_error',
          message(error),
          error instanceof Error ? error : undefined,
        ),
      )
    }
  }

  /** Stop every group this env still runs, as Pi's cleanup does, then Pi's own. A close reports, never throws. */
  async cleanup(context: Context) {
    const running = [...this.running]
    this.running.clear()
    for (const { group, pidFile } of running) {
      const pid = group.child.pid
      if (pid === undefined) continue
      await stopGroup(pid, { pidFile, leader: group }).catch((error: unknown) =>
        // A group that will not die must not stop storage from closing; report it once.
        console.error(`Stopping process group ${pid} failed: ${message(error)}`),
      )
    }
    await super.cleanup(context)
  }
}

/** A spill file attached to the failure, as Pi reports it for a command that timed out or was aborted. */
function withSpill(error: ExecutionError, spill: Spill | undefined) {
  if (spill?.path !== undefined) error.spillPath = spill.path
  return error
}

function exists(path: string) {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch (error) {
    // Only a missing shell changes the answer; anything else (permissions) surfaces when it is spawned.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}
