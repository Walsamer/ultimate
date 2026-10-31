/**
 * OpenDesign's own HTTP API, as the extension uses it. Every tool of OpenDesign's MCP server is a `fetch` against these
 * routes (`apps/daemon/src/mcp.ts`), so this speaks to the daemon directly and needs no MCP. Reads only: the extension
 * never writes to OpenDesign.
 */

/** Where the daemon listens unless told otherwise (`DEFAULT_DAEMON_URL` in `apps/daemon/src/daemon-url.ts`). */
export const defaultUrl = 'http://127.0.0.1:7456'

/** Basic auth's username is fixed by the daemon (`API_TOKEN_BASIC_USERNAME` in `apps/daemon/src/api-token-auth.ts`). */
const username = 'open-design'

export interface Daemon {
  url: string
  /** `OD_API_TOKEN` in the app; the daemon skips auth for loopback peers, so this is only needed from elsewhere. */
  token?: string
}

export interface ActiveContext {
  active: boolean
  projectId?: string | null
  projectName?: string | null
  fileName?: string | null
  ageMs?: number | null
}

export interface ProjectSummary {
  id: string
  name: string
  designSystemId?: string | null
}

export interface ProjectDetail extends ProjectSummary {
  metadata?: Record<string, unknown> | null
}

export interface RemoteFile {
  path: string
  mime?: string
  size?: number | null
}

/** One row of `GET /api/projects/:id/files`, whose name the daemon repeats as `path`. */
interface RemoteFileRow {
  name?: string
  path?: string
  mime?: string
  size?: number | null
}

/** A request the daemon refused or never answered, with the sentence the user acts on. */
export class DaemonError extends Error {
  readonly kind: 'unreachable' | 'auth' | 'missing' | 'failed'
  constructor(kind: DaemonError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

function auth(daemon: Daemon): Record<string, string> {
  if (!daemon.token) return {}
  return { authorization: `Basic ${Buffer.from(`${username}:${daemon.token}`).toString('base64')}` }
}

function unreachable(daemon: Daemon, error: unknown): string {
  const code = (error as { cause?: { code?: string } }).cause?.code
  return `Cannot reach OpenDesign at ${daemon.url}${code ? ` (${code})` : ''}. Start the OpenDesign app, or set "opendesign.url" in .ultimate/settings.json to the daemon it runs.`
}

function answered(daemon: Daemon, path: string, status: number, detail: string): string {
  if (status === 401 || status === 403)
    return `OpenDesign refused the request at ${daemon.url}: add the API token from OpenDesign's settings as the secret OPEN_DESIGN_API_TOKEN (⌘K → Secrets).`
  if (status === 404)
    return `OpenDesign has nothing at ${path} on ${daemon.url}${detail ? ` (${detail})` : ''}: the project or file is gone, or this OpenDesign version renamed the route.`
  return `OpenDesign answered ${status} for ${path}${detail ? `: ${detail}` : ''}.`
}

/** A failed response's own explanation, one bounded line. */
async function detailOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return ''
  try {
    const body = JSON.parse(text) as { error?: { message?: string }; message?: string }
    const message = body.error?.message ?? body.message
    if (typeof message === 'string') return message.slice(0, 200)
  } catch {
    // Not JSON: the body itself is the explanation.
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

async function request(
  daemon: Daemon,
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${daemon.url}${path}`, {
      ...init,
      headers: { ...auth(daemon), ...(init.headers as Record<string, string> | undefined) },
      signal,
    })
  } catch (error) {
    // The caller stopping is not a daemon failure; it is reported as itself.
    if (signal.aborted) throw error
    throw new DaemonError('unreachable', unreachable(daemon, error))
  }
  if (response.ok) return response
  const detail = await detailOf(response)
  const kind = response.status === 401 || response.status === 403 ? 'auth' : 'failed'
  throw new DaemonError(kind, answered(daemon, path, response.status, detail))
}

async function json<T>(daemon: Daemon, path: string, signal: AbortSignal): Promise<T> {
  const response = await request(daemon, path, signal)
  try {
    return (await response.json()) as T
  } catch {
    throw new DaemonError('failed', `OpenDesign answered ${path} with something that is not JSON.`)
  }
}

/** The project and file the user has open in OpenDesign, expiring about five minutes after their last interaction. */
export async function active(daemon: Daemon, signal: AbortSignal): Promise<ActiveContext> {
  return json<ActiveContext>(daemon, '/api/active', signal)
}

/** Every project on the daemon. */
export async function projects(daemon: Daemon, signal: AbortSignal): Promise<ProjectSummary[]> {
  const body = await json<{ projects?: ProjectSummary[] }>(daemon, '/api/projects', signal)
  return (Array.isArray(body?.projects) ? body.projects : []).filter(
    (row) => typeof row?.id === 'string' && typeof row?.name === 'string',
  )
}

/** One project's row, including the metadata that names its entry file. */
export async function project(
  daemon: Daemon,
  id: string,
  signal: AbortSignal,
): Promise<ProjectDetail> {
  const body = await json<{ project?: ProjectDetail }>(
    daemon,
    `/api/projects/${encodeURIComponent(id)}`,
    signal,
  )
  const found = body?.project
  if (!found || typeof found.id !== 'string')
    throw new DaemonError('missing', `OpenDesign has no project ${id}.`)
  return found
}

/** Every file of a project, without their contents. */
export async function files(
  daemon: Daemon,
  id: string,
  signal: AbortSignal,
): Promise<RemoteFile[]> {
  const body = await json<{ files?: RemoteFileRow[] }>(
    daemon,
    `/api/projects/${encodeURIComponent(id)}/files`,
    signal,
  )
  return (Array.isArray(body?.files) ? body.files : []).flatMap((row) => {
    const path = row?.path ?? row?.name
    return typeof path === 'string' ? [{ path, mime: row.mime, size: row.size }] : []
  })
}

/** One project file's bytes, as the daemon serves them (the route `get_artifact` pulls every file through). */
export async function file(
  daemon: Daemon,
  id: string,
  path: string,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: string }> {
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/')
  const response = await request(
    daemon,
    `/api/projects/${encodeURIComponent(id)}/raw/${segments}`,
    signal,
  )
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mime: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim(),
  }
}

/**
 * One PNG of the design as OpenDesign renders it, or why there is none. The daemon renders it with the desktop app's
 * Chromium (`POST /api/projects/:id/export/image` in `apps/daemon/src/import-export-routes.ts`), so a web-only
 * OpenDesign answers 501 and the pull goes without a frame.
 */
export async function frame(
  daemon: Daemon,
  id: string,
  fileName: string,
  signal: AbortSignal,
): Promise<{ bytes: Buffer } | { reason: string }> {
  const path = `/api/projects/${encodeURIComponent(id)}/export/image`
  let response: Response
  try {
    response = await fetch(`${daemon.url}${path}`, {
      method: 'POST',
      headers: { ...auth(daemon), 'content-type': 'application/json' },
      body: JSON.stringify({ fileName }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    return { reason: unreachable(daemon, error) }
  }
  if (!response.ok) {
    const detail = await detailOf(response)
    return {
      reason:
        response.status === 501
          ? 'OpenDesign renders a frame only from its desktop app, so this pull has none.'
          : `OpenDesign could not render a frame${detail ? `: ${detail}` : ` (${response.status})`}.`,
    }
  }
  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('image/'))
    return { reason: `OpenDesign answered the frame request with ${type || 'no type'}.` }
  return { bytes: Buffer.from(await response.arrayBuffer()) }
}
