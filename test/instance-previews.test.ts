import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  instanceUrl,
  previewEnv,
  previewWorkspace,
  remember,
  seedUserHome,
  stopped,
} from '../extensions/instance/server.ts'
import { READY_GIVE_UP, waitForReady } from '../extensions/instance/readiness.ts'
import { saveDefinition } from '../lib/agents.ts'
import { writeFamilies } from '../lib/families-settings.ts'
import { writeJson } from '../lib/json-file.ts'
import { at, label } from '../extensions/instance/links.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
/** A host with its own resources over `home`, as a fresh process over the same home would be. */
function hostOver(home: string) {
  const resources = new Map<string, unknown>()
  return {
    home,
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
  }
}
const preview = (port: number, conversationId = 1) => ({
  id: `p${port}-${conversationId}`,
  url: `http://127.0.0.1:${port}`,
  conversationId,
})

it('reads the URL an instance announced, whatever host it bound', () => {
  // Regression: only a 127.0.0.1 URL was read, so a start that printed localhost, a LAN or Tailscale address left
  // the probe without a URL and the caller was told "Instance did not become ready" about a running instance.
  expect(instanceUrl('Ultimate: http://127.0.0.1:4748')).toBe('http://127.0.0.1:4748')
  expect(instanceUrl('Ultimate: http://localhost:4748')).toBe('http://localhost:4748')
  expect(instanceUrl('Ultimate: http://100.101.102.103:4748')).toBe('http://100.101.102.103:4748')
  expect(instanceUrl('Ultimate: http://[::1]:4748')).toBe('http://[::1]:4748')
  expect(instanceUrl('Ultimate: https://host.example.ts.net:4748')).toBe(
    'https://host.example.ts.net:4748',
  )
  // Anything that is not that one line stays unread: a malformed line never becomes a URL to fetch.
  expect(instanceUrl('Ultimate: starting…')).toBeUndefined()
  expect(instanceUrl('Ultimate: http://')).toBeUndefined()
  expect(instanceUrl('Ultimate: not a url')).toBeUndefined()
  expect(instanceUrl('  Ultimate: http://127.0.0.1:4748')).toBeUndefined()
  expect(instanceUrl('Ultimate: http://127.0.0.1:4748 (remote)')).toBeUndefined()
})

it('previews the nearest owner worktree of a subagent, else the host checkout', async () => {
  // Branch 10 has a worktree; 11 is its subagent and 12 a subagent of that. 20 owns 21, neither isolated.
  const owners: Record<number, number> = { 11: 10, 12: 11, 21: 20 }
  const branch = { path: '/worktrees/10', state: 'ready' }
  const host = {
    harness: () => ({
      commit: async <T>(run: (tx: unknown) => Promise<T>) =>
        run({
          conversation: async (id: ConversationId) =>
            owners[id] === undefined ? { id } : { id, owner: { conversationId: owners[id] } },
        }),
    }),
  }
  const workspaces = { get: async (id: ConversationId) => (id === 10 ? branch : undefined) }
  const resolve = (id: number) =>
    previewWorkspace(host as never, workspaces as never, id as ConversationId, BACKGROUND_CONTEXT)
  expect(await resolve(11)).toBe(branch)
  expect(await resolve(12)).toBe(branch)
  expect(await resolve(21)).toBeUndefined()
})

it('isolates preview cloud environment and host identity', () => {
  const parent = {
    PATH: '/bin',
    ULTIMATE_SUPERVISED: '1',
    ULTIMATE_PUBLIC_URL: 'https://parent.example',
    ULTIMATE_GENERATION: '7',
    ULTIMATE_PREVIOUS_BUILD: 'parent-build',
    ULTIMATE_HOME: '/parent/state',
    ULTIMATE_PROJECT: '/parent/project',
    HOME: '/parent/user',
    ULTIMATE_USER_HOME: '/parent/config',
    ULTIMATE_PORT: '4747',
    ULTIMATE_NO_OPEN: '0',
    ULTIMATE_INSTANCE_OWNER: '111',
    ULTIMATE_CLOUD_URL: 'wss://parent.example/sync',
    ULTIMATE_CLOUD_TOKEN: 'parent-token',
    ULTIMATE_CLOUD_MACHINE: 'parent-machine',
  }
  const before = { ...parent }
  const child = previewEnv(parent, {
    home: '/preview/state',
    project: '/preview/project',
    userHome: '/preview/user',
    ownerPid: 222,
  })
  expect(child).not.toHaveProperty('ULTIMATE_CLOUD_URL')
  expect(child).not.toHaveProperty('ULTIMATE_CLOUD_TOKEN')
  expect(child).not.toHaveProperty('ULTIMATE_CLOUD_MACHINE')
  expect(child).toEqual({
    PATH: '/bin',
    ULTIMATE_HOME: '/preview/state',
    ULTIMATE_PROJECT: '/preview/project',
    HOME: '/parent/user',
    ULTIMATE_USER_HOME: '/preview/user',
    ULTIMATE_PORT: '0',
    ULTIMATE_NO_OPEN: '1',
    ULTIMATE_INSTANCE_OWNER: '222',
  })
  expect(parent).toEqual(before)
})

// Regression: preview clicks moved an agent in a linked ~/.ultimate/agents/*.md and saved a linked
// model-families.json, both kept in the user's dotfiles repository.
it("keeps a preview's agent and family writes out of the user's linked config", async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-preview-user-'))
  homes.push(root)
  const [dotfiles, user, copy] = ['dotfiles', 'user', 'preview'].map((name) => join(root, name))
  const agent = '---\nname: helper\ndescription: Helps\n---\nHelp.\n'
  await mkdir(join(dotfiles, 'agents'), { recursive: true })
  await mkdir(join(user, '.ultimate/agents'), { recursive: true })
  await writeFile(join(dotfiles, 'agents/helper.md'), agent)
  await writeFile(join(dotfiles, 'model-families.json'), '{}\n')
  await symlink(join(dotfiles, 'agents/helper.md'), join(user, '.ultimate/agents/helper.md'))
  await symlink(join(dotfiles, 'model-families.json'), join(user, '.ultimate/model-families.json'))

  await seedUserHome(user, copy)
  const runtime = await ModelRuntime.create()
  await saveDefinition(
    { projectRoot: root, userHome: copy },
    runtime,
    'user',
    'helper',
    { description: 'Moved' },
    'Help.',
  )
  await writeFamilies(copy, root, {})

  expect(await readFile(join(dotfiles, 'agents/helper.md'), 'utf8')).toBe(agent)
  expect(await readFile(join(dotfiles, 'model-families.json'), 'utf8')).toBe('{}\n')
  expect(await readFile(join(copy, '.ultimate/agents/helper.md'), 'utf8')).toContain('Moved')
  expect(await readFile(join(copy, '.ultimate/model-families.json'), 'utf8')).toContain('recent')
  // Every preview and the host pick Tailscale ports in one registry, even one the preview creates.
  await writeJson(join(copy, '.ultimate/tailscale.json'), { ports: {} })
  expect(await readFile(join(user, '.ultimate/tailscale.json'), 'utf8')).toContain('ports')
})

it('remembers stopped previews across restarts, one per port, the last 50', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-previews-'))
  homes.push(home)
  const before = hostOver(home)
  for (let port = 40000; port < 40052; port++) remember(before, preview(port))
  remember(before, preview(40051, 7))

  const after = hostOver(home)
  const kept = [...stopped(after).values()]
  expect(kept).toHaveLength(50)
  expect(kept[0].url).toBe('http://127.0.0.1:40002')
  expect(kept.filter((item) => item.url.endsWith(':40051'))).toEqual([preview(40051, 7)])
  expect(JSON.parse(await readFile(join(home, 'previews.json'), 'utf8'))).toHaveLength(50)
})

it('starts with no stopped previews in a fresh home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ultimate-previews-'))
  homes.push(home)
  expect(stopped(hostOver(home)).size).toBe(0)
})

it('keeps a link on the preview origin even when its path starts with //', () => {
  const link = new URL('http://127.0.0.1:45939//evil.example/x?conversation=1#top')
  expect(at('http://127.0.0.1:45939', link)).toBe(
    'http://127.0.0.1:45939//evil.example/x?conversation=1#top',
  )
  expect(new URL(at('https://host.ts.net:4747', link)).host).toBe('host.ts.net:4747')
})

it('labels a preview chip with the URL it opens when its text is that link', () => {
  const tailnet = 'https://rog.tail3a3a66.ts.net:46335/'
  expect(label('http://127.0.0.1:46335', 'http://127.0.0.1:46335/', tailnet)).toBe(
    'https://rog.tail3a3a66.ts.net:46335',
  )
  expect(
    label(
      'http://127.0.0.1:46335/?conversation=3',
      'http://127.0.0.1:46335/?conversation=3',
      'https://rog.tail3a3a66.ts.net:46335/?conversation=3',
    ),
  ).toBe('https://rog.tail3a3a66.ts.net:46335/?conversation=3')
  expect(label('the preview', 'http://127.0.0.1:46335/', tailnet)).toBe('the preview')
})

const started = 'http://127.0.0.1:4748'
/**
 * A fake child to wait on: a clock the wait advances a probe at a time, when it announces and answers, and when it is
 * gone. Nothing here waits for real, so a five-minute deadline costs no wall clock.
 */
function fakeStart(options: {
  announcesAt?: number
  answersAt?: number
  endedAt?: number
  ended?: string
  output?: string
  signal?: AbortSignal
}) {
  const clock = { at: 0 }
  const reports: string[] = []
  const wait = waitForReady({
    signal: options.signal,
    url: () =>
      clock.at >= (options.announcesAt ?? Number.POSITIVE_INFINITY) ? started : undefined,
    output: () => options.output ?? '',
    ended: () =>
      options.endedAt !== undefined && clock.at >= options.endedAt ? options.ended : undefined,
    responds: async () => options.answersAt !== undefined && clock.at >= options.answersAt,
    elapsed: () => clock.at,
    report: (text) => reports.push(text),
    pause: async () => {
      clock.at += 250
    },
  })
  return { reports, wait }
}

// Regression: 28 of 31 recorded preview failures read "Instance did not become ready" followed by a wall of Vite
// output, saying neither that no URL had ever been announced nor how long the wait had been.
it('names what a start waited for, quoting only the tail of the output', async () => {
  const output = [
    '7:15:46 pm [vite] (client) [optimizer] scanning dependencies...',
    '7:15:50 pm [vite] (client) [optimizer] bundling dependencies...',
  ].join('\n')
  const { wait, reports } = fakeStart({ output })
  const error = (await wait.catch((caught: unknown) => caught)) as Error
  expect(error.message).toContain('no URL announced (the child printed no `Ultimate: <url>` line)')
  expect(error.message).toContain(`after ${READY_GIVE_UP / 1000} s`)
  expect(error.message).toContain('the child was still running')
  expect(error.message).toContain('Last 2 lines of its output:\n' + output)
  // The wait became visible when it passed the report mark, instead of staying silent until it gave up.
  expect(reports[0]).toBe('Still starting after 60 s: no URL announced yet.')
  expect(reports.at(-1)).toBe('Still starting after 285 s: no URL announced yet.')
})

// Regression: a start that succeeded took 42 s, and attempts at 60-67 s were still bundling dependencies. The old
// fixed 60 s deadline threw those away as if the child had died.
it('keeps waiting past the 60-second report mark for a child that announces late', async () => {
  const { wait, reports } = fakeStart({ announcesAt: 120_000, answersAt: 150_000 })
  expect(await wait).toBe(started)
  expect(reports[0]).toBe('Still starting after 60 s: no URL announced yet.')
  expect(reports).toContain(`Waiting for ${started} after 120 s; it has not answered yet.`)
})

// Regression: a child that exited was reported as one that never became ready, hiding the reason it died.
it('reports a child that exited instead of calling it slow', async () => {
  const { wait } = fakeStart({
    endedAt: 5_000,
    ended: 'the child exited with code 1',
    output: 'Error: No such file or directory\n',
  })
  const error = (await wait.catch((caught: unknown) => caught)) as Error
  expect(error.message).toContain('after 5 s')
  expect(error.message).toContain('no URL announced')
  expect(error.message).toContain('the child exited with code 1')
  expect(error.message).toContain('No such file or directory')
})

it('stops waiting when the caller aborts', async () => {
  const controller = new AbortController()
  controller.abort()
  const { wait } = fakeStart({ signal: controller.signal })
  await expect(wait).rejects.toThrow(/abort/i)
})
