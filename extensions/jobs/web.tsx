/**
 * The transcript's job card: the one passive entry (`jobs.finished`) a job writes when it ends. It answers what ran, how
 * it ended and how long it took at a glance — a failing job colours its rule and names its exit code, a clean one stays
 * quiet — and opening it shows where it ran, its pid, its log and its exact times. A job nobody watched end says so.
 */
import {
  ChevronRightIcon,
  CircleStopIcon,
  LoaderCircleIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import {
  cn,
  defineWebExtension,
  formatDuration,
  formatTime,
  shortenPath,
  useConversation,
  useStore,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { JobCard } from './refs.ts'

/** A path as this conversation reads it: relative to its directory, else with `~` for home. */
function usePath(path: string) {
  const cwd = useConversation((conversation) => conversation.agent.cwd)
  const defaultCwd = useStore((state) => state.system?.execution.defaultCwd)
  const home = useStore((state) => state.system?.machine.home)
  return shortenPath(path, { cwd: cwd ?? defaultCwd, home })
}

/** How a job ended, in the words a reader of the card uses. */
function ending(card: JobCard) {
  if (card.state === 'stopped') return { word: 'stopped', tone: 'text-muted-foreground' }
  if (card.unknown) return { word: 'unwatched', tone: 'text-warning' }
  if (card.exitCode === undefined || card.exitCode === 0)
    return { word: 'exited 0', tone: 'text-muted-foreground' }
  return { word: `exited ${card.exitCode}`, tone: 'text-destructive' }
}

/** The state's mark: a failure's cross and a stopped job's circle stand out; a clean exit stays quiet. */
function Mark({ card }: { card: JobCard }) {
  if (card.state === 'stopped')
    return <CircleStopIcon className="size-3.5 shrink-0 text-muted-foreground" />
  if (card.unknown) return <LoaderCircleIcon className="size-3.5 shrink-0 text-warning" />
  if (card.exitCode === undefined || card.exitCode === 0)
    return <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
  return <XIcon className="size-3.5 shrink-0 text-destructive" />
}

/** The command's first line; the whole of it is the header's title. */
const first = (command: string) => command.trim().split('\n')[0]

function Details({ card }: { card: JobCard }) {
  const cwd = usePath(card.cwd)
  const log = usePath(card.log)
  return (
    <div className="space-y-2 px-3 py-2.5 text-[12px]">
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-background/60 px-2 py-1.5 font-mono text-[11.5px] leading-5 text-foreground/85">
        <span className="text-muted-foreground">$ </span>
        {card.command}
      </pre>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        <dt className="text-muted-foreground">ran</dt>
        <dd className="text-foreground/70">
          {formatDuration(card.endedAt - card.startedAt)} · {formatTime(card.startedAt, true)} →{' '}
          {formatTime(card.endedAt, true)}
        </dd>
        <dt className="text-muted-foreground">in</dt>
        <dd className="truncate text-foreground/70" title={card.cwd}>
          {cwd}
        </dd>
        <dt className="text-muted-foreground">log</dt>
        <dd className="truncate text-foreground/70" title={card.log}>
          {log}
        </dd>
      </dl>
      {card.unknown && (
        <p className="text-[11.5px] leading-4 text-warning">
          Nobody watched it end: the host closed while it ran, so this is when its exit was found.
          Its log holds everything it printed until then.
        </p>
      )}
    </div>
  )
}

function JobEntry({ entry }: { entry: EntryRecord }) {
  const card = entry.data as JobCard
  const look = ending(card)
  const [open, setOpen] = useState(false)
  const failed = card.exitCode !== undefined && card.exitCode !== 0
  return (
    <section
      className={cn(
        'min-w-0 rounded-md border border-border border-l-2 bg-muted/20',
        failed ? 'border-l-destructive/60' : 'border-l-brand/50',
      )}
      data-job={card.id}
      data-job-state={card.unknown ? 'unknown' : card.state}
    >
      <button
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-2 text-left font-mono text-[11px] transition-colors hover:bg-accent/40"
        onClick={() => setOpen((value) => !value)}
        title={open ? 'Hide the job’s details' : 'Show the job’s details'}
        type="button"
      >
        <ChevronRightIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <Mark card={card} />
        <span className="shrink-0 text-muted-foreground">{card.id}</span>
        {card.label && <span className="shrink-0 text-foreground">{card.label}</span>}
        <span className="min-w-0 truncate text-foreground/80" title={card.command}>
          {first(card.command)}
        </span>
        <span className={cn('shrink-0', look.tone)}>{look.word}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {formatDuration(card.endedAt - card.startedAt)}
        </span>
      </button>
      {open && <Details card={card} />}
    </section>
  )
}

export default defineWebExtension({
  entries: { 'jobs.finished': JobEntry },
})
