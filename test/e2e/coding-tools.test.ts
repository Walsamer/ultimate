import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import { context } from '../../server/harness.ts'
import { fauxServer, temp, removeTemp } from '../helpers.ts'

it('stops default bash at the tripwire, kills its process, and preserves explicit timeout errors', async () => {
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '0.1')
  const directory = await temp('ultimate-bash-tripwire-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  try {
    const pidFile = join(directory, 'pid')
    for (const explicit of [false, true]) {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('bash', {
              command: `echo $$ > '${pidFile}'; sleep 10`,
              ...(explicit ? { timeout: 0.2 } : {}),
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Complete'),
      ])
      const started = performance.now()
      await (await server.root.submit({ type: 'input', content: 'Run' }, context)).wait(context)
      expect(performance.now() - started).toBeLessThan(4000)
      const view = await server.root.viewState(context)
      try {
        const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
          ?.model?.[0]
        expect(result?.role === 'toolResult' && result.isError).toBe(true)
        expect(JSON.stringify(result)).toContain(
          explicit
            ? 'Command timed out after 0.2 seconds'
            : 'Tripwire: bash ran past the 0.1 s default limit',
        )
        expect(JSON.stringify(result).includes('Tripwire:')).toBe(!explicit)
      } finally {
        view.dispose()
      }
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow('ESRCH')
    }
  } finally {
    vi.unstubAllEnvs()
    await server.close()
    await removeTemp(directory)
  }
})

it('reports what a finished call left running, and stays quiet when it left nothing', async () => {
  const directory = await temp('ultimate-bash-leftovers-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  const call = async (commands: { command: string }[], pidFile?: string) => {
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        commands.map(({ command }) => fauxToolCall('bash', { command })),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Complete'),
    ])
    await (await server.root.submit({ type: 'input', content: 'Run' }, context)).wait(context)
    const view = await server.root.viewState(context)
    try {
      const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)!
      return (
        (result.data as { diagnostics?: { code?: string; message: string }[] }).diagnostics ?? []
      )
    } finally {
      view.dispose()
    }
  }
  try {
    const pidFile = join(directory, 'child.pid')
    const leftovers = await call([{ command: `sleep 30 & echo $! > '${pidFile}'` }])
    expect(leftovers.map((item) => item.message)).toContain(
      'Stopped 1 process the command left running. Use the background tool for work that should outlive the call.',
    )
    // The child the command backgrounded is gone with the call.
    const child = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(child, 0)).toThrow('ESRCH')
    // A call that left nothing behind says nothing.
    const plain = await call([{ command: 'echo plain' }])
    expect(plain.some((item) => item.code === 'left_running')).toBe(false)
  } finally {
    await server.close()
    await removeTemp(directory)
  }
})
