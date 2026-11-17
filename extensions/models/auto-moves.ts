/** One root notice per refused-model episode; subsequent recoveries extend its list rather than adding root cards. */
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import type { AutoMoves, FamilyMove } from './refs.ts'

export const AutoMovesState = defineDoc<AutoMoves>({
  kind: 'models.auto-moves',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ groups: {} }),
})

export async function recordAutoMove(tx: Tx, move: FamilyMove, until: number) {
  const state = await tx.doc(AutoMovesState, ROOT_CONVERSATION_ID)
  const now = Date.now()
  const previous = Object.entries(state.groups).findLast(
    ([, group]) => group.from === move.from && group.until > now,
  )
  const key = previous?.[0] ?? `${move.from}:${now}`
  const group = previous?.[1] ?? { from: move.from, until, moves: [] }
  group.until = Math.max(group.until, until)
  const index = group.moves.findIndex((item) => item.id === move.id)
  if (index < 0) group.moves.push(move)
  else group.moves[index] = move
  state.groups[key] = group
  if (previous) return
  await tx.appendEntry(ROOT_CONVERSATION_ID, {
    kind: 'models.auto-moved',
    data: { key },
    model: [
      {
        role: 'user',
        content: `Automatic model recovery: #${move.id} ${move.title} moved from ${move.from} to ${move.to}. Further recoveries from this outage are grouped in models.auto-moves on the root.`,
        timestamp: now,
      },
    ],
  })
}
