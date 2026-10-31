/**
 * The OpenDesign contract this extension depends on, driven against a stub daemon: OpenDesign is not installed on this
 * machine, so these tests are the only place the routes, the Basic auth and the pull's snapshot behaviour are exercised.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { relativePath, slugOf } from '../.ultimate/extensions/opendesign/bundle.ts'
import opendesign, { actions } from '../.ultimate/extensions/opendesign/server.ts'
import type { ActionContext } from '../server/actions.ts'

const made: string[] = []
const servers: Server[] = []
const token = 'od-live-token-9f2c'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

interface Fixture {
  /** Required as the Basic password when set; a mismatch answers 401 like the daemon does. */
  token?: string
  active?: { projectId: string; fileName: string | null } | null
  projects: { id: string; name: string; entry?: string }[]
  files: Record<string, { path: string; mime: string; body: string }[]>
  /** Whether `POST /api/projects/:id/export/image` renders a PNG (desktop app) or answers 501 (web only). */
  frame: boolean
}

const png = Buffer.from('89504e470d0a1a0a-frame', 'latin1')

/** OpenDesign's daemon as this extension uses it: `/api/active`, projects, files, raw files and the image export. */
async function stub(fixture: Fixture): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    seen.push(`${request.method} ${url.pathname}`)
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (fixture.token) {
      const expected = `Basic ${Buffer.from(`open-design:${fixture.token}`).toString('base64')}`
      if (request.headers.authorization !== expected)
        return json(401, {
          error: { code: 'API_TOKEN_REQUIRED', message: 'Authorization required' },
        })
    }
    if (url.pathname === '/api/active')
      return json(
        200,
        fixture.active
          ? {
              active: true,
              ...fixture.active,
              projectName: fixture.projects.find(
                (project) => project.id === fixture.active?.projectId,
              )?.name,
              ageMs: 2000,
            }
          : { active: false },
      )
    if (url.pathname === '/api/projects')
      return json(200, {
        projects: fixture.projects.map((project) => ({ id: project.id, name: project.name })),
      })
    const project = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!project) return json(404, { error: { message: 'no such route' } })
    const found = fixture.projects.find(
      (candidate) => candidate.id === decodeURIComponent(project[1]),
    )
    if (!found) return json(404, { error: { code: 'PROJECT_NOT_FOUND', message: 'not found' } })
    const rest = project[2] ?? ''
    if (rest === '')
      return json(200, {
        project: {
          id: found.id,
          name: found.name,
          metadata: found.entry ? { entryFile: found.entry } : {},
        },
      })
    if (rest === '/files')
      return json(200, {
        files: (fixture.files[found.id] ?? []).map((file) => ({
          path: file.path,
          name: file.path,
          mime: file.mime,
          size: file.body.length,
        })),
      })
    if (rest === '/export/image') {
      if (!fixture.frame)
        return json(501, {
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'screenshot export is only available in the desktop runtime',
          },
        })
      response.writeHead(200, { 'content-type': 'image/png' })
      return response.end(png)
    }
    const raw = /^\/raw\/(.+)$/.exec(rest)
    if (raw) {
      const path = decodeURIComponent(raw[1])
      const file = (fixture.files[found.id] ?? []).find((candidate) => candidate.path === path)
      if (!file) return json(404, { error: { code: 'FILE_NOT_FOUND', message: 'not found' } })
      response.writeHead(200, { 'content-type': file.mime })
      return response.end(file.body)
    }
    return json(404, { error: { message: 'no such route' } })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the stub did not bind a port')
  return { url: `http://127.0.0.1:${address.port}`, seen }
}

/** A project folder in a temporary home, with `opendesign.url` pointing at `url`. */
async function workspace(url: string) {
  const root = await mkdtemp(join(tmpdir(), 'opendesign-'))
  made.push(root)
  const ctx = {
    host: {
      projectRoot: root,
      userHome: root,
      projectSettings: async () => ({ 'opendesign.url': url }),
    },
    signal: new AbortController().signal,
  } as unknown as ActionContext
  return { root, ctx }
}

/** The secret store as the settings panel writes it, so the token path is a real one. */
async function secret(userHome: string, value: string) {
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/secrets.json'),
    JSON.stringify({
      secrets: { OPEN_DESIGN_API_TOKEN: { value, updatedAt: '2026-10-31T10:00:00.000Z' } },
    }),
    { mode: 0o600 },
  )
}

const landing = (): Fixture => ({
  projects: [{ id: 'p1', name: 'Landing Page', entry: 'index.html' }],
  active: { projectId: 'p1', fileName: 'index.html' },
  frame: true,
  files: {
    p1: [
      {
        path: 'index.html',
        mime: 'text/html',
        body: '<h1>Landing</h1><link rel="stylesheet" href="app.css">',
      },
      { path: 'app.css', mime: 'text/css', body: ':root { --ink: #111; }' },
      { path: 'screens/hero.png', mime: 'image/png', body: 'not-really-a-png' },
      { path: '../escape.txt', mime: 'text/plain', body: 'must not be written' },
    ],
  },
})

it('pulls a design into designs/<slug>/, with its manifest and frame, and says what changed next time', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const fixture = landing()
  const daemon = await stub(fixture)
  const { root, ctx } = await workspace(daemon.url)
  await secret(root, 'unused-here')

  const first = await actions.pull({ project: 'Landing Page' }, ctx)
  expect(first.slug).toBe('landing-page')
  expect(first.files).toBe(3)
  expect(first.entry).toBe('index.html')
  expect(first.frame).toBe('frame.png')
  expect(first.change).toEqual({
    added: ['index.html', 'app.css', 'screens/hero.png'],
    changed: [],
    removed: [],
    unchanged: 0,
  })

  const dir = join(root, 'designs', 'landing-page')
  expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe(fixture.files.p1[0].body)
  expect(await readFile(join(dir, 'screens/hero.png'), 'utf8')).toBe('not-really-a-png')
  expect(await readFile(join(dir, 'frame.png'))).toEqual(png)
  // The name that would leave the design folder was left out, and nothing was written outside it.
  expect(first.skipped.map((file) => file.path)).toEqual(['../escape.txt'])
  await expect(stat(join(root, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

  const manifest = JSON.parse(await readFile(join(dir, 'design.json'), 'utf8')) as {
    generated: string
    project: { id: string; name: string }
    source: string
    entry: string
    frame: string
    files: { path: string; sha256: string }[]
    skipped: { path: string }[]
  }
  expect(manifest.generated).toContain('do not edit; pull again')
  expect(manifest.project).toEqual({ id: 'p1', name: 'Landing Page', designSystemId: null })
  expect(manifest.source).toBe(daemon.url)
  expect(manifest.entry).toBe('index.html')
  expect(manifest.frame).toBe('frame.png')
  expect(manifest.files.map((file) => file.path)).toEqual([
    'index.html',
    'app.css',
    'screens/hero.png',
  ])
  expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(manifest.skipped.map((file) => file.path)).toEqual(['../escape.txt'])

  const again = await actions.pull({}, ctx)
  expect(again.change).toEqual({ added: [], changed: [], removed: [], unchanged: 3 })

  // One file changed, one gone: the pull reports both and the old file leaves the folder.
  fixture.files.p1 = fixture.files.p1.filter((file) => file.path !== 'screens/hero.png')
  fixture.files.p1[0] = { ...fixture.files.p1[0], body: '<h1>Landing v2</h1>' }
  const third = await actions.pull({ project: 'p1' }, ctx)
  expect(third.change).toEqual({
    added: [],
    changed: ['index.html'],
    removed: ['screens/hero.png'],
    unchanged: 1,
  })
  await expect(stat(join(dir, 'screens/hero.png'))).rejects.toMatchObject({ code: 'ENOENT' })

  // The token the pull used never reaches a result, the manifest, or a log line.
  expect(JSON.stringify(third)).not.toContain(token)
  expect(JSON.stringify(manifest)).not.toContain(token)
  expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain(token)
})

it('pulls without a frame when OpenDesign cannot render one, and says why', async () => {
  const fixture = { ...landing(), frame: false }
  const daemon = await stub(fixture)
  const { root, ctx } = await workspace(daemon.url)
  const result = await actions.pull({ project: 'p1' }, ctx)
  expect(result.frame).toBeNull()
  expect(result.frameError).toContain('desktop app')
  const manifest = JSON.parse(
    await readFile(join(root, 'designs', 'landing-page/design.json'), 'utf8'),
  ) as { frame: string | null; frameError: string }
  expect(manifest.frame).toBeNull()
  expect(manifest.frameError).toContain('desktop app')
})

it('answers every not-there case with one sentence naming what to fix, without the token', async () => {
  const fixture = { ...landing(), token }
  const daemon = await stub(fixture)
  const { root, ctx } = await workspace(daemon.url)

  // Nothing open in OpenDesign: no project is guessed.
  const quiet = await stub({ ...landing(), active: null })
  const { ctx: noActive } = await workspace(quiet.url)
  expect((await actions.active(null, noActive)) as { active: unknown }).toMatchObject({
    status: 'ok',
    active: null,
  })
  await expect(actions.pull({}, noActive)).rejects.toThrow(
    /Nothing is open in OpenDesign right now/,
  )

  // The daemon wants a token and the secret holds another one.
  await secret(root, 'the-wrong-token')
  await expect(actions.pull({ project: 'p1' }, ctx)).rejects.toThrow(/OPEN_DESIGN_API_TOKEN/)
  expect(await actions.overview(null, ctx)).toMatchObject({
    status: 'unauthorized',
    url: daemon.url,
  })
  const refused = (await actions.overview(null, ctx)) as { message: string }
  expect(refused.message).toContain('OPEN_DESIGN_API_TOKEN')
  expect(refused.message).not.toContain('the-wrong-token')

  // The daemon is not running at all.
  const gone = await stub(landing())
  const { ctx: unreachable } = await workspace(gone.url)
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
  await expect(actions.pull({ project: 'p1' }, unreachable)).rejects.toThrow(
    /Cannot reach OpenDesign at .* Start the OpenDesign app, or set "opendesign.url"/,
  )
  expect(await actions.overview(null, unreachable)).toMatchObject({ status: 'unreachable' })
})

it('tells the agent the same sentence through its tool, and pulls by name', async () => {
  const fixture = landing()
  const daemon = await stub(fixture)
  const { root, ctx } = await workspace(daemon.url)
  const tools = opendesign(ctx.host).tools ?? []
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`no ${name} tool`)
    // These tools read nothing from the execution API or the harness context; neither exists outside a run.
    const api = {} as Parameters<typeof tool.execute>[1]
    const context = { abortSignal: ctx.signal } as Parameters<typeof tool.execute>[2]
    const result = await tool.execute(args, api, context)
    const [first] = result.output ?? []
    return {
      text: first && first.type === 'text' ? first.text : '',
      isError: result.isError === true,
    }
  }

  const pulled = await run('design_pull', { project: 'Landing Page' })
  expect(pulled.isError).toBe(false)
  expect(pulled.text).toContain('designs/landing-page')
  expect(pulled.text).toContain('3 files')
  expect(pulled.text).toContain('do not edit')
  expect(await stat(join(root, 'designs/landing-page/index.html'))).toBeTruthy()

  const listed = await run('design_list', {})
  expect(listed.text).toContain('Landing Page (p1)')
  expect(listed.text).toContain('pulled')
  const active = await run('design_active', {})
  expect(active.text).toContain('Landing')
  expect(active.text).toContain('design_pull')
})

it('keeps a bundle entry from escaping the design folder', () => {
  expect(relativePath('../escape.txt')).toBeUndefined()
  expect(relativePath('a/../../b')).toBeUndefined()
  expect(relativePath('/etc/passwd')).toBeUndefined()
  expect(relativePath('..\\..\\escape.txt')).toBeUndefined()
  expect(relativePath('C:/Windows/win.ini')).toBeUndefined()
  expect(relativePath('a\u0000b')).toBeUndefined()
  expect(relativePath('')).toBeUndefined()
  expect(relativePath('screens/./hero.png')).toBe('screens/hero.png')
  expect(relativePath('nested/deep/file.css')).toBe('nested/deep/file.css')

  expect(slugOf({ id: 'p1', name: 'Landing Page' })).toBe('landing-page')
  expect(slugOf({ id: 'p1', name: 'Über Café / v2' })).toBe('uber-cafe-v2')
  expect(slugOf({ id: '9f2c7b1e-0d3a', name: '✨' })).toBe('design-9f2c7b1e')
})
