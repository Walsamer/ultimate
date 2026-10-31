/**
 * Designs in the right panel: what the user has open in OpenDesign, every project it holds, and one Pull button per
 * project that writes a snapshot into `designs/<slug>/`. Quiet by design — the panel answers "what has this repository
 * taken from OpenDesign, and what changed?" and nothing else.
 */
import { PenToolIcon, RotateCwIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  actionRef,
  api,
  cn,
  defineWebExtension,
  errorMessage,
  formatAgo,
  notify,
  useAction,
  useNow,
} from '@/sdk'

/** A project's snapshot already in the repository. */
interface Pulled {
  at: string
  files: number
}

interface Project {
  id: string
  name: string
  pulled: Pulled | null
}

interface Open {
  projectId: string
  projectName: string | null
  fileName: string | null
  ageMs: number | null
}

type Overview =
  | {
      status: 'ok'
      url: string
      designsDir: string
      token: boolean
      active: Open | null
      projects: Project[]
    }
  | { status: 'unreachable' | 'unauthorized' | 'failed'; url: string; message: string }

interface Result {
  project: { id: string; name: string }
  slug: string
  entry: string | null
  frame: string | null
  frameError?: string
  files: number
  change: { added: string[]; changed: string[]; removed: string[]; unchanged: number }
  at: string
}

/** No arguments → the daemon, the designs folder, what is open and every project with its pulled state. */
const OverviewAction = actionRef<null, Overview>('opendesign', 'overview')
/** `{ project? }` → what the pull wrote and what changed; omitting the project takes the one open in OpenDesign. */
const PullAction = actionRef<{ project?: string }, Result>('opendesign', 'pull')

/** `1 file`, `3 files`. */
const count = (files: number) => `${files} ${files === 1 ? 'file' : 'files'}`

/** The pull in one line: files, and what moved since the pull before this one. */
function summary(result: Result): string {
  const { added, changed, removed } = result.change
  const moved = [
    added.length && `${added.length} added`,
    changed.length && `${changed.length} changed`,
    removed.length && `${removed.length} removed`,
  ].filter(Boolean)
  return `designs/${result.slug} · ${count(result.files)}${moved.length ? ` · ${moved.join(', ')}` : ' · unchanged'}`
}

/** One project: its name, what the repository holds of it, and the Pull button. */
function Row({
  project,
  busy,
  result,
  pull,
}: {
  project: Project
  busy: boolean
  result: Result | string | undefined
  pull: () => void
}) {
  const now = useNow(30_000)
  return (
    <li className="px-3 py-1">
      <div className="flex h-6 min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[12px] text-foreground/85" title={project.id}>
          {project.name}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
          {project.pulled
            ? `pulled ${formatAgo(Date.parse(project.pulled.at), now, { ago: true })} · ${count(project.pulled.files)}`
            : 'not pulled'}
        </span>
        <Button
          className="ml-auto h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={pull}
          size="xs"
          title={`Pull ${project.name} into designs/`}
          variant="ghost"
        >
          <RotateCwIcon className={cn('size-3', busy && 'animate-spin')} />
          {busy ? 'pulling' : 'pull'}
        </Button>
      </div>
      {typeof result === 'string' ? (
        <p className="pb-1 text-[11.5px] text-error/90">{result}</p>
      ) : result ? (
        <p className="pb-1 font-mono text-[11px] text-muted-foreground/80">{summary(result)}</p>
      ) : null}
    </li>
  )
}

/** The daemon is not answering, or refused the token: one sentence, what to fix, and the url it was said at. */
function Problem({ view, retry }: { view: Overview; retry: () => void }) {
  if (view.status === 'ok') return null
  return (
    <div className="px-3 pt-1 pb-3" data-opendesign-problem={view.status}>
      <p className="text-[12px] leading-[1.5] text-foreground/85">{view.message}</p>
      <p className="pt-1 font-mono text-[11px] text-muted-foreground/70">{view.url}</p>
      <Button
        className="mt-2 h-5 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
        onClick={retry}
        size="xs"
        variant="ghost"
      >
        <RotateCwIcon className="size-3" />
        try again
      </Button>
    </div>
  )
}

function DesignsPanel() {
  // A failed call is rendered as the panel's own problem line, so it needs no second notice.
  const overview = useAction(OverviewAction, null, { onError: () => {} })
  const [pulling, setPulling] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, Result | string>>({})

  async function pull(project?: string) {
    const key = project ?? 'active'
    setPulling(key)
    try {
      const result = await api.action(PullAction, project === undefined ? {} : { project })
      setResults((previous) => ({ ...previous, [key]: result }))
      await overview.refetch()
    } catch (failure) {
      setResults((previous) => ({ ...previous, [key]: errorMessage(failure) }))
    } finally {
      setPulling(null)
    }
  }

  const view = overview.data
  const active = view?.status === 'ok' ? view.active : null
  const projects = view?.status === 'ok' ? view.projects : []
  // The open project first, the rest in the daemon's order.
  const ordered = active
    ? [
        ...projects.filter((project) => project.id === active.projectId),
        ...projects.filter((project) => project.id !== active.projectId),
      ]
    : projects

  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        OpenDesign
        <Button
          aria-label="Refresh OpenDesign projects"
          className="ml-auto size-5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => void overview.refetch()}
          size="icon"
          title="Ask OpenDesign again"
          variant="ghost"
        >
          <RotateCwIcon className={cn('size-3', overview.loading && 'animate-spin')} />
        </Button>
      </div>
      {!view ? (
        <p className="px-3 font-mono text-[11.5px] text-muted-foreground">
          {overview.loading ? 'asking OpenDesign…' : 'no answer'}
        </p>
      ) : view.status !== 'ok' ? (
        <Problem retry={() => void overview.refetch()} view={view} />
      ) : (
        <>
          <div className="px-3 pb-1" data-opendesign-active>
            {active ? (
              <>
                <div className="flex h-6 min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-[12px] text-foreground/85">
                    {active.projectName ?? active.projectId}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
                    {active.fileName ?? 'no file open'}
                  </span>
                  <Button
                    className="ml-auto h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    disabled={pulling === 'active'}
                    onClick={() => void pull()}
                    size="xs"
                    title="Pull what is open in OpenDesign into designs/"
                    variant="ghost"
                  >
                    <RotateCwIcon
                      className={cn('size-3', pulling === 'active' && 'animate-spin')}
                    />
                    {pulling === 'active' ? 'pulling' : 'pull'}
                  </Button>
                </div>
                {typeof results.active === 'string' ? (
                  <p className="pb-1 text-[11.5px] text-error/90">{results.active}</p>
                ) : results.active ? (
                  <p className="pb-1 font-mono text-[11px] text-muted-foreground/80">
                    {summary(results.active)}
                  </p>
                ) : (
                  <p className="pb-1 text-[11px] text-muted-foreground/60">
                    the file you have open in OpenDesign
                  </p>
                )}
              </>
            ) : (
              <p className="pb-1 text-[11.5px] leading-[1.5] text-muted-foreground/80">
                Nothing is open in OpenDesign. Click into a project there and it shows up here for
                about five minutes.
              </p>
            )}
          </div>
          <div className="border-t border-border/60 py-1">
            <div className="px-3 pb-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
              Projects
            </div>
            {ordered.length === 0 ? (
              <p className="px-3 pb-1 text-[11.5px] text-muted-foreground/80">
                No projects in OpenDesign yet.
              </p>
            ) : (
              <ul>
                {ordered.map((project) => (
                  <Row
                    busy={pulling === project.id}
                    key={project.id}
                    project={project}
                    pull={() => void pull(project.id)}
                    result={results[project.id]}
                  />
                ))}
              </ul>
            )}
          </div>
          <p
            className="truncate px-3 pt-2 font-mono text-[10.5px] text-muted-foreground/60"
            title={`${view.url}\ndesigns in ${view.designsDir}${view.token ? '\ntoken set' : ''}`}
          >
            {view.url} · {view.designsDir}
            {view.token && ' · token set'}
          </p>
        </>
      )}
    </div>
  )
}

export default defineWebExtension({
  panels: [{ id: 'opendesign', title: 'Designs', icon: PenToolIcon, component: DesignsPanel }],
  commands: [
    {
      id: 'opendesign.panel',
      title: 'Show designs from OpenDesign',
      run: (context) => context.openPanel('opendesign'),
    },
    {
      id: 'opendesign.pull',
      title: 'Pull the design open in OpenDesign',
      run: async () => {
        const result = await api.action(PullAction, {})
        notify({ level: 'info', message: `Pulled ${result.project.name} into ${summary(result)}` })
      },
    },
  ],
})
