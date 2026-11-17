import { CpuIcon, LoaderCircleIcon } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage, useDocOf, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { refOf } from '../../lib/families.ts'
import { refreshFamilies } from './families.tsx'
import {
  AutoMovesDoc,
  PreviewFamiliesAction,
  ReportFamilyMovesAction,
  SaveFamiliesAction,
} from './refs.ts'
import type { FamilyMove, SaveFamilies } from './refs.ts'

type Asked = { args: SaveFamilies; moves: FamilyMove[]; resolve: () => void }
let asked: Asked | undefined
const listeners = new Set<() => void>()
function setAsked(next: Asked | undefined) {
  asked = next
  for (const listener of listeners) listener()
}

/** Nothing is saved or moved until the named conversations have been shown and the user answers. */
export async function saveWithMoves(args: SaveFamilies) {
  const moves = await api.action(PreviewFamiliesAction, args)
  if (!moves.length) {
    await api.action(SaveFamiliesAction, args)
    await refreshFamilies()
    return
  }
  if (asked) throw new Error('Finish the open family change first')
  await new Promise<void>((resolve) => setAsked({ args, moves, resolve }))
}

function MoveList({ moves }: { moves: FamilyMove[] }) {
  return (
    <ul className="max-h-[35vh] space-y-2 overflow-y-auto">
      {moves.map((move) => (
        <li className="min-w-0" key={move.id}>
          <div className="break-words text-foreground">
            #{move.id} · {move.title}
          </div>
          <div className="break-all text-[11px] text-muted-foreground">
            {move.from} → {move.to}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Family changes use the same configure route, including its smaller-window guard, as the model picker. */
export function FamilyMovesDialog() {
  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => asked,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [finished, setFinished] = useState(false)
  function close() {
    if (busy) return
    setAsked(undefined)
    setError(undefined)
    setFinished(false)
    request?.resolve()
  }
  async function answer(move: boolean) {
    if (!request || busy) return
    setBusy(true)
    setError(undefined)
    try {
      // Recheck before saving: a conversation re-pointed while the question was open stays where it was put.
      const current = move ? await api.action(PreviewFamiliesAction, request.args) : []
      await api.action(SaveFamiliesAction, request.args)
      await refreshFamilies()
      const moved: FamilyMove[] = []
      const failures: string[] = []
      for (const item of request.moves) {
        if (
          !current.some(
            (next) => next.id === item.id && next.from === item.from && next.to === item.to,
          )
        )
          continue
        try {
          await api.configure({ model: refOf(item.to)! }, item.id)
          moved.push(item)
        } catch (failure) {
          failures.push(`#${item.id} ${item.title}: ${errorMessage(failure)}`)
        }
      }
      if (moved.length) {
        try {
          await api.action(ReportFamilyMovesAction, {
            requestId: crypto.randomUUID(),
            moves: moved,
          })
        } catch (failure) {
          setError(
            `Families saved and ${moved.length} conversations moved, but the root notice failed: ${errorMessage(failure)}`,
          )
          setFinished(true)
          return
        }
      }
      if (failures.length) {
        setError(`Families saved. These conversations were not moved: ${failures.join('\n')}`)
        setFinished(true)
      } else {
        setAsked(undefined)
        request.resolve()
      }
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) close()
      }}
      open={!!request}
    >
      <DialogContent
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogTitle className="flex items-center gap-1.5 border-b border-border/70 px-3 py-2.5 text-[12px] font-normal">
          <CpuIcon className="size-3.5 text-brand" /> Move open conversations too?
        </DialogTitle>
        <div className="space-y-3 px-3 py-3 text-[12px] leading-relaxed">
          <DialogDescription className="text-[12px]">
            New conversations will use the updated families. These open conversations still run on
            the replaced model.
          </DialogDescription>
          <MoveList moves={request?.moves ?? []} />
          <p className="text-[11px] text-muted-foreground">
            Moving changes their next request, not a request already running. A smaller window still
            needs a separate choice before condensing.
          </p>
          {error && (
            <p className="whitespace-pre-wrap text-warning" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2.5">
          {finished ? (
            <Button className="h-7 text-[12px]" onClick={close} size="sm">
              Done
            </Button>
          ) : (
            <>
              <Button
                className="h-7 gap-1.5 text-[12px]"
                disabled={busy}
                onClick={() => void answer(true)}
                size="sm"
              >
                {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />} Save and move
              </Button>
              <Button
                className="h-7 text-[12px]"
                disabled={busy}
                onClick={() => void answer(false)}
                size="sm"
                variant="outline"
              >
                Save, keep open conversations
              </Button>
              <Button
                className="h-7 text-[12px]"
                disabled={busy}
                onClick={close}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One passive root outcome for an accepted batch, with links to every conversation it moved. */
export function FamilyMoved({ entry }: { entry: EntryRecord }) {
  const { moves } = entry.data as { moves: FamilyMove[] }
  return <MovedCard moves={moves} label="Model families" />
}

export function AutoMoved({ entry }: { entry: EntryRecord }) {
  const { key } = entry.data as { key: string }
  const state = useDocOf(1, AutoMovesDoc)
  return <MovedCard moves={state?.groups[key]?.moves} label="Automatic model recovery" />
}

function MovedCard({ moves, label }: { moves: FamilyMove[] | undefined; label: string }) {
  const actions = useUltimate()
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/60 bg-muted/20"
      data-models-family-moved
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CpuIcon className="size-3.5 text-brand" /> {label} ·{' '}
        {moves
          ? `${moves.length} ${moves.length === 1 ? 'conversation moved' : 'conversations moved'}`
          : 'loading…'}
      </header>
      <div className="space-y-2 px-3 py-3 font-mono text-[12px]">
        {moves?.map((move) => (
          <div key={move.id}>
            <button
              className="text-left break-words hover:text-brand"
              onClick={() => actions.switchConversation(move.id)}
              type="button"
            >
              #{move.id} · {move.title}
            </button>
            <div className="break-all text-[11px] text-muted-foreground">
              {move.from} → {move.to}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
