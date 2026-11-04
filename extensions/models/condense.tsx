import { CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { errorMessage, useDialog } from '@/sdk'
import { closeCondense, dialogs, switchModel, useAskedSwitch } from './state.tsx'

/**
 * The answer to picking a model that cannot hold the conversation it was picked for. Pi would condense everything
 * above that model's threshold into one summary on its next turn — written by the smaller model, and with nothing
 * asked — so the switch waits here instead. Condensing first keeps the reading the model that holds the conversation
 * had of it; switching anyway lets the next turn do the condensation; cancelling changes nothing.
 */
export function CondenseDialog() {
  const [open, setOpen] = useDialog(dialogs.condense)
  const asked = useAskedSwitch()
  const [busy, setBusy] = useState<'before' | 'anyway'>()
  const [error, setError] = useState<string>()

  function close() {
    setOpen(false)
    setBusy(undefined)
    setError(undefined)
    closeCondense()
  }

  function answer(condense: 'before' | 'anyway') {
    if (!asked || busy) return
    setBusy(condense)
    setError(undefined)
    switchModel(asked.model, asked.id, {
      thinkingLevel: asked.thinkingLevel,
      condense,
    }).then(close, (failure: unknown) => {
      setBusy(undefined)
      setError(errorMessage(failure))
    })
  }

  return (
    <Dialog onOpenChange={(next) => (next ? setOpen(true) : close())} open={open}>
      <DialogContent
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          Switch to a model too small for this conversation?
        </DialogTitle>
        <DialogDescription className="sr-only">
          A model that cannot hold this conversation condenses it into one summary on its next turn.
        </DialogDescription>
        <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-2.5 text-[11px] text-warning">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          <span>smaller window · this switch would condense the conversation</span>
        </div>
        <div className="space-y-3 px-3 py-3 text-[13px] leading-relaxed">
          <p className="text-muted-foreground">{asked?.question}</p>
          <p className="text-muted-foreground">
            Condensing first writes the summary on{' '}
            <span className="text-foreground">the model this conversation runs on now</span>, which
            holds all of it. Switching anyway lets the next turn write it on the smaller model
            instead.
          </p>
          {error ? <p className="text-warning">{error}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2.5">
          <Button
            className="h-7 gap-1.5 text-[12px]"
            disabled={!!busy}
            onClick={() => answer('before')}
            size="sm"
          >
            {busy === 'before' ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            Condense first, then switch
          </Button>
          <Button
            className="h-7 gap-1.5 text-[12px]"
            disabled={!!busy}
            onClick={() => answer('anyway')}
            size="sm"
            variant="outline"
          >
            {busy === 'anyway' ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            Switch anyway
          </Button>
          <Button
            className="h-7 text-[12px]"
            disabled={!!busy}
            onClick={close}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
