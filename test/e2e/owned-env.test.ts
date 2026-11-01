import { readdir, readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { expect, it } from 'vitest'
import { OwnedExecutionEnv } from '../../server/owned-env.ts'
import { context } from '../../server/harness.ts'
import { groupAlive, spawnGroup } from '../../lib/process-group.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

/** Output `exec` streamed, and what it settled with. */
async function run(
  env: NodeExecutionEnv,
  command: string,
  options: Parameters<NodeExecutionEnv['exec']>[1] = {},
) {
  let output = ''
  const result = await env.exec(
    command,
    {
      ...options,
      onOutput: (text: string) => {
        output += text
      },
    },
    context,
  )
  return { output, result }
}

it('runs a command as an ordinary shell does: same output, same exit code, nothing left behind', async () => {
  const directory = await temp('ultimate-owned-env-')
  const shellDir = join(directory, 'shell')
  const owned = new OwnedExecutionEnv({ cwd: directory, shellDir })
  const inner = new NodeExecutionEnv({ cwd: directory })
  try {
    for (const command of ['echo hi; echo oops >&2; exit 0', 'printf a; printf b; exit 3']) {
      const mine = await run(owned, command)
      const theirs = await run(inner, command)
      expect(mine.output).toBe(theirs.output)
      expect(mine.result).toEqual(theirs.result)
    }
    // A call records its group's pid for a later sweep, and removes it when the group is done.
    expect(await readdir(shellDir)).toEqual([])
  } finally {
    await owned.cleanup(context)
    await inner.cleanup(context)
    await removeTemp(directory)
  }
})

it('stops what a command leaves running when its leader exits', async () => {
  const directory = await temp('ultimate-owned-env-')
  const owned = new OwnedExecutionEnv({ cwd: directory, shellDir: join(directory, 'shell') })
  try {
    const { output, result } = await run(owned, 'sleep 30 & echo $!')
    expect(result.ok).toBe(true)
    const child = Number(output.trim())
    expect(child).toBeGreaterThan(0)
    // The backgrounded sleep was still in the shell's group when the shell exited, and the drain stopped it.
    await until(() => !groupAlive(child))
    expect(groupAlive(child)).toBe(false)
  } finally {
    await owned.cleanup(context)
    await removeTemp(directory)
  }
})

it('spills the complete output past the caller thresholds exactly as the inner env does', async () => {
  const directory = await temp('ultimate-owned-env-')
  const owned = new OwnedExecutionEnv({ cwd: directory, shellDir: join(directory, 'shell') })
  const inner = new NodeExecutionEnv({ cwd: directory })
  const spill = { afterBytes: 64, afterLines: 2 }
  try {
    const command = 'for i in $(seq 1 20); do echo line-$i; done'
    const mine = await run(owned, command, { spill })
    const theirs = await run(inner, command, { spill })
    expect(mine.result.ok && mine.result.value.exitCode).toBe(0)
    expect(theirs.result.ok).toBe(true)
    const minePath = mine.result.ok ? mine.result.value.spillPath : undefined
    const theirPath = theirs.result.ok ? theirs.result.value.spillPath : undefined
    expect(minePath).toBeDefined()
    expect(theirPath).toBeDefined()
    expect(await readFile(minePath!, 'utf8')).toBe(await readFile(theirPath!, 'utf8'))
    expect(mine.output).toBe(theirs.output)
  } finally {
    await owned.cleanup(context)
    await inner.cleanup(context)
    await removeTemp(directory)
  }
})

it('maps a timeout, an abort and a spawn failure to their own errors', async () => {
  const directory = await temp('ultimate-owned-env-')
  const owned = new OwnedExecutionEnv({ cwd: directory, shellDir: join(directory, 'shell') })
  try {
    const slow = await run(owned, 'sleep 30', { timeout: 0.1 })
    expect(slow.result.ok).toBe(false)
    expect(!slow.result.ok && slow.result.error.code).toBe('timeout')

    const controller = new AbortController()
    const running = owned.exec('sleep 30', {}, { abortSignal: controller.signal } as typeof context)
    controller.abort()
    const aborted = await running
    expect(!aborted.ok && aborted.error.code).toBe('aborted')

    const missing = await run(owned, 'true', { cwd: join(directory, 'gone') })
    expect(!missing.result.ok && missing.result.error.code).toBe('spawn_error')

    const invalid = await run(owned, 'true', { timeout: 0 })
    expect(!invalid.result.ok && invalid.result.error.code).toBe('timeout')
  } finally {
    await owned.cleanup(context)
    await removeTemp(directory)
  }
})

it('stops a group a crashed host left behind when the harness opens', async () => {
  const directory = await temp('ultimate-owned-env-')
  const home = join(directory, 'home')
  const shellDir = join(home, 'shell')
  await mkdir(shellDir, { recursive: true })
  const pidFile = join(shellDir, 'left-behind.pid')
  const group = spawnGroup('/bin/sh', ['-c', 'sleep 30'], { pidFile })
  const pid = group.child.pid!
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: directory })
  try {
    await until(() => !groupAlive(pid))
    expect(groupAlive(pid)).toBe(false)
    expect(await readdir(shellDir)).toEqual([])
  } finally {
    await server.close()
    await removeTemp(directory)
  }
})
