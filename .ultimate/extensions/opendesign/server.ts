/**
 * Pull a design out of OpenDesign into the repository. OpenDesign owns the design; this writes a read-only snapshot into
 * `designs/<slug>/` — the files, a frame PNG, and `design.json` naming where they came from — and reports what changed
 * since the pull before it. Nothing is ever written back to OpenDesign.
 */

import { join, relative, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { readSecret } from '../../../lib/secrets.ts'
import {
  entryOf,
  frameName,
  generatedLine,
  inside,
  manifestName,
  pulled,
  record,
  readManifest,
  selectFiles,
  slugOf,
  writeBundle,
} from './bundle.ts'
import type { ChangeSet, Manifest, PulledFile, SkippedFile } from './bundle.ts'
import * as od from './daemon.ts'

export const secrets = [
  {
    name: 'OPEN_DESIGN_API_TOKEN',
    description:
      'OpenDesign API token, from the app under Settings → API. Only needed when the daemon does not trust this machine (Docker, a proxy); a local daemon lets loopback requests through.',
    url: 'https://github.com/nexu-io/open-design',
  },
]

const noActive =
  "Nothing is open in OpenDesign right now. The active project expires about five minutes after the user's last interaction, so they may need to click into a project in OpenDesign; or name one from design_list."

/** What the extension needs from the host: the project it writes into, and the request's abort signal. */
interface Session {
  host: Pick<ExtensionHost, 'projectRoot' | 'userHome' | 'projectSettings'>
  signal: AbortSignal
}

interface Config {
  daemon: od.Daemon
  designs: string
}

/**
 * `opendesign.url` and `opendesign.designsDir` from the project's settings, and the token from the secret store — or the
 * screen to show when a setting cannot be used at all.
 */
async function configure(session: Session): Promise<Config | Blocked> {
  const settings = await session.host.projectSettings()
  const configured = settings['opendesign.url']
  const url =
    typeof configured === 'string' && configured ? configured.replace(/\/+$/, '') : od.defaultUrl
  if (!/^https?:\/\//.test(url))
    return {
      status: 'failed',
      url,
      message: `"opendesign.url" must be an http(s) URL, not ${JSON.stringify(configured)}. Set it in .ultimate/settings.json.`,
    }
  const directory = settings['opendesign.designsDir']
  const designs = resolve(
    session.host.projectRoot,
    typeof directory === 'string' && directory ? directory : 'designs',
  )
  const token = await readSecret(session.host.userHome, 'OPEN_DESIGN_API_TOKEN')
  return { daemon: { url, token }, designs }
}

function field(args: JsonValue, key: string): unknown {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args[key] : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The project a call names: an id, its exact name, then a unique part of a name. */
function pick(projects: readonly od.ProjectSummary[], wanted: string): od.ProjectSummary {
  const lower = wanted.toLowerCase()
  const match =
    projects.find((project) => project.id === wanted) ??
    projects.find((project) => project.name.toLowerCase() === lower) ??
    projects.find((project) => project.name.toLowerCase().includes(lower))
  if (match) return match
  const names = projects.map((project) => `"${project.name}"`).join(', ')
  throw new Error(
    `OpenDesign has no project ${JSON.stringify(wanted)}. It has: ${names || 'none'}. Call design_list for their ids.`,
  )
}

/** The project a pull takes: the one named, else the one open in OpenDesign. */
async function target(
  daemon: od.Daemon,
  wanted: string | undefined,
  signal: AbortSignal,
): Promise<od.ProjectSummary> {
  if (wanted) return pick(await od.projects(daemon, signal), wanted)
  const active = await od.active(daemon, signal)
  if (!active?.active || !active.projectId) throw new Error(noActive)
  return { id: active.projectId, name: active.projectName ?? active.projectId }
}

interface PullResult {
  project: { id: string; name: string }
  slug: string
  dir: string
  entry: string | null
  frame: string | null
  frameError?: string
  files: number
  change: ChangeSet
  skipped: SkippedFile[]
  at: string
}

/** A folder under `designs/` for this project: its slug, unless another project's snapshot already owns that name. */
async function folderFor(designs: string, project: od.ProjectSummary): Promise<string> {
  const base = slugOf(project)
  const taken = await readManifest(join(designs, base))
  if (!taken || taken.project.id === project.id) return base
  return `${base}-${project.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`
}

async function pull(session: Session, wanted?: string): Promise<PullResult> {
  const config = await configure(session)
  if ('status' in config) throw new Error(config.message)
  const { daemon, designs } = config
  const { signal } = session
  const found = await target(daemon, wanted, signal)
  const detail = await od.project(daemon, found.id, signal)
  const listing = await od.files(daemon, found.id, signal)
  const { wanted: names, skipped } = selectFiles(listing)
  const entry = entryOf(listing, detail.metadata?.entryFile)
  const files: PulledFile[] = []
  for (const file of names) {
    try {
      const fetched = await od.file(daemon, found.id, file.path, signal)
      files.push({ path: file.path, mime: fetched.mime, bytes: fetched.bytes })
    } catch (error) {
      // One unreadable asset leaves the rest of the design pulled; the manifest says which and why.
      skipped.push({ path: file.path, reason: messageOf(error) })
    }
  }
  let frame: Buffer | undefined
  let frameError: string | undefined
  if (!entry) frameError = 'the project has no entry file to render'
  else {
    const rendered = await od.frame(daemon, found.id, entry, signal)
    if ('bytes' in rendered) frame = rendered.bytes
    else frameError = rendered.reason
  }
  // The folder is named from the project row, not from however the pull found the project, so every pull of a project
  // lands in the same place.
  const slug = await folderFor(designs, { id: found.id, name: detail.name || found.name })
  const dir = join(designs, slug)
  const before = await readManifest(dir)
  const at = new Date().toISOString()
  const manifest: Manifest = {
    generated: generatedLine,
    project: {
      id: found.id,
      name: detail.name ?? found.name,
      designSystemId: detail.designSystemId ?? null,
    },
    source: daemon.url,
    fetchedAt: at,
    entry,
    frame: frame ? frameName : null,
    ...(frameError ? { frameError } : {}),
    files: files.map(record),
    skipped,
  }
  const { change } = await writeBundle(dir, files, manifest, before, frame)
  return {
    project: { id: manifest.project.id, name: manifest.project.name },
    slug,
    dir,
    entry,
    frame: manifest.frame,
    ...(frameError ? { frameError } : {}),
    files: files.length,
    change,
    skipped,
    at,
  }
}

/** What the user has open, or nothing, with what they would do about it. */
interface ActiveView {
  status: 'ok'
  active: {
    projectId: string
    projectName: string | null
    fileName: string | null
    ageMs: number | null
  } | null
}

async function activeView(session: Session): Promise<ActiveView | Blocked> {
  const config = await configure(session)
  if ('status' in config) return config
  const { daemon } = config
  try {
    const active = await od.active(daemon, session.signal)
    if (!active?.active || !active.projectId) return { status: 'ok', active: null }
    return {
      status: 'ok',
      active: {
        projectId: active.projectId,
        projectName: active.projectName ?? null,
        fileName: active.fileName ?? null,
        ageMs: active.ageMs ?? null,
      },
    }
  } catch (error) {
    return blocked(daemon, error)
  }
}

interface ProjectView {
  id: string
  name: string
  pulled: { at: string; files: number } | null
}

interface ListView {
  status: 'ok'
  url: string
  projects: ProjectView[]
}

interface Blocked {
  status: 'unreachable' | 'unauthorized' | 'failed'
  url: string
  message: string
}

interface OverviewView {
  status: 'ok'
  url: string
  designsDir: string
  token: boolean
  active: ActiveView['active']
  projects: ProjectView[]
}

/** The daemon failed in a way the UI shows as a screen of its own rather than as rows with nothing behind them. */
function blocked(daemon: od.Daemon, error: unknown): Blocked {
  const kind = error instanceof od.DaemonError ? error.kind : 'failed'
  const status =
    kind === 'unreachable' ? 'unreachable' : kind === 'auth' ? 'unauthorized' : 'failed'
  return { status, url: daemon.url, message: messageOf(error) }
}

async function listView(session: Session): Promise<ListView | Blocked> {
  const config = await configure(session)
  if ('status' in config) return config
  const { daemon, designs } = config
  try {
    const projects = await od.projects(daemon, session.signal)
    return { status: 'ok', url: daemon.url, projects: await withPulled(projects, designs) }
  } catch (error) {
    return blocked(daemon, error)
  }
}

/** The projects as the panel lists them, each with what the repository already holds of it. */
async function withPulled(
  projects: readonly od.ProjectSummary[],
  designs: string,
): Promise<ProjectView[]> {
  const snapshots = await pulled(designs)
  return projects.map((project) => {
    const snapshot = snapshots.get(project.id)
    return {
      id: project.id,
      name: project.name,
      pulled: snapshot ? { at: snapshot.fetchedAt, files: snapshot.files } : null,
    }
  })
}

async function overview(session: Session): Promise<OverviewView | Blocked> {
  const config = await configure(session)
  if ('status' in config) return config
  const { daemon, designs } = config
  const root = session.host.projectRoot
  try {
    const [active, projects] = await Promise.all([
      od.active(daemon, session.signal),
      od.projects(daemon, session.signal),
    ])
    return {
      status: 'ok',
      url: daemon.url,
      designsDir: inside(root, designs) ? relative(root, designs) : designs,
      token: Boolean(daemon.token),
      active:
        active?.active && active.projectId
          ? {
              projectId: active.projectId,
              projectName: active.projectName ?? null,
              fileName: active.fileName ?? null,
              ageMs: active.ageMs ?? null,
            }
          : null,
      projects: await withPulled(projects, designs),
    }
  } catch (error) {
    return blocked(daemon, error)
  }
}

/** The pull as the agent reads it: where the design landed and what moved since the pull before. */
function pullText(result: PullResult, root: string): string {
  const folder = relative(root, result.dir)
  const lines = [
    `Pulled "${result.project.name}" into ${folder} (${result.files} file${result.files === 1 ? '' : 's'}: ${result.change.added.length} added, ${result.change.changed.length} changed, ${result.change.removed.length} removed, ${result.change.unchanged} unchanged).`,
    `Entry: ${result.entry ?? 'none'}. Frame: ${result.frame ?? `none — ${result.frameError ?? 'not rendered'}`}.`,
  ]
  if (result.change.added.length) lines.push(`Added: ${result.change.added.join(', ')}`)
  if (result.change.changed.length) lines.push(`Changed: ${result.change.changed.join(', ')}`)
  if (result.change.removed.length) lines.push(`Removed: ${result.change.removed.join(', ')}`)
  if (result.skipped.length)
    lines.push(
      `Left out: ${result.skipped.map((file) => `${file.path} (${file.reason})`).join(', ')}`,
    )
  lines.push(
    `The design is a snapshot: do not edit ${folder}/, pull again instead. ${folder}/${manifestName} lists its files.`,
  )
  return lines.join('\n')
}

function age(ms: number | null | undefined): string {
  if (typeof ms !== 'number') return 'just now'
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

function activeText(view: ActiveView): string {
  if (view.status !== 'ok' || !view.active) return noActive
  const { projectName, projectId, fileName, ageMs } = view.active
  return `OpenDesign shows "${projectName ?? projectId}" (${projectId})${fileName ? `, file ${fileName}` : ''}, touched ${age(ageMs)}. Call design_pull to bring it into designs/.`
}

function listText(view: ListView): string {
  if (!view.projects.length) return `OpenDesign at ${view.url} has no projects yet.`
  return [
    `Projects in OpenDesign at ${view.url}:`,
    ...view.projects.map(
      (project) =>
        `- ${project.name} (${project.id}) — ${
          project.pulled
            ? `pulled ${project.pulled.at}, ${project.pulled.files} file${project.pulled.files === 1 ? '' : 's'}`
            : 'not pulled yet'
        }`,
    ),
    'Call design_pull { project: "<id or name>" } to bring one into designs/.',
  ].join('\n')
}

function sessionOf(host: ExtensionHost, signal?: AbortSignal): Session {
  return { host, signal: signal ?? new AbortController().signal }
}

export const actions = {
  /** What the user has open in OpenDesign, or null — `{ status: 'ok', active }` or a `Blocked` screen when the daemon is not reachable. */
  async active(_args: JsonValue, ctx: ActionContext) {
    return activeView(sessionOf(ctx.host, ctx.signal))
  },
  /** Every OpenDesign project with what has been pulled of it — `{ status: 'ok', projects }` or a `Blocked` screen. */
  async list(_args: JsonValue, ctx: ActionContext) {
    return listView(sessionOf(ctx.host, ctx.signal))
  },
  /** The panel's one call: the url, the designs folder, what is open and every project with its pulled state. */
  async overview(_args: JsonValue, ctx: ActionContext) {
    return overview(sessionOf(ctx.host, ctx.signal))
  },
  /** Pull a project's design into `designs/<slug>/`; `{ project? }` names it, omitting it takes the one open. */
  async pull(args: JsonValue, ctx: ActionContext) {
    const wanted = field(args, 'project')
    return pull(
      sessionOf(ctx.host, ctx.signal),
      typeof wanted === 'string' && wanted.trim() ? wanted.trim() : undefined,
    )
  },
}

export default function opendesign(host: ExtensionHost) {
  return defineExtension({
    name: 'opendesign',
    tools: [
      defineTool({
        name: 'design_active',
        // Reading what OpenDesign shows writes nothing, here or in OpenDesign.
        replay: 'safe',
        description:
          'What the user has open in OpenDesign right now: the project and the file. Answers plainly when nothing is open (the active context expires about five minutes after their last interaction); then ask them to click into OpenDesign, or pick a project with design_list. Pull it with design_pull before implementing a design.',
        parameters: Type.Object({}),
        async execute(_args, _api, context) {
          const view = await activeView(sessionOf(host, context.abortSignal))
          if (view.status !== 'ok')
            return { output: [{ type: 'text' as const, text: view.message }], isError: true }
          return { output: [{ type: 'text' as const, text: activeText(view) }] }
        },
      }),
      defineTool({
        name: 'design_list',
        // Listing projects only reads the daemon.
        replay: 'safe',
        description:
          'Every project in OpenDesign, with what has already been pulled into designs/, for choosing one when nothing is open. Pull one with design_pull.',
        parameters: Type.Object({}),
        async execute(_args, _api, context) {
          const view = await listView(sessionOf(host, context.abortSignal))
          if (view.status !== 'ok')
            return { output: [{ type: 'text' as const, text: view.message }], isError: true }
          return { output: [{ type: 'text' as const, text: listText(view) }] }
        },
      }),
      defineTool({
        name: 'design_pull',
        description:
          'Pull a design out of OpenDesign into designs/<slug>/ in this repository: every file at its relative path, a frame PNG when OpenDesign can render one, and design.json (project, source, fetched time, file list, "do not edit; pull again"). Answers what was written and what changed since the last pull. Pull before implementing a design, then compare a screenshot of the implementation against the pulled files.',
        parameters: Type.Object({
          project: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                'Project id or name in OpenDesign. Omit to take the project the user has open; design_list names them.',
            }),
          ),
        }),
        async execute(args, _api, context) {
          try {
            const result = await pull(sessionOf(host, context.abortSignal), args.project)
            return { output: [{ type: 'text' as const, text: pullText(result, host.projectRoot) }] }
          } catch (error) {
            return {
              output: [{ type: 'text' as const, text: messageOf(error) }],
              isError: true,
            }
          }
        },
      }),
    ],
  })
}
