import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  action: vi.fn<(ref: { name: string }, args: unknown) => Promise<unknown>>(),
  configure: vi.fn<(args: unknown, id: number) => Promise<void>>(),
  buttons: new Map<string, () => void>(),
  pass: ({ children }: { children?: ReactNode }) => children ?? null,
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))
vi.mock('@/sdk', () => ({
  api: { action: f.action, configure: f.configure },
  errorMessage: (error: Error) => error.message,
  useUltimate: () => ({}),
  useDocOf: () => undefined,
}))
vi.mock('../../extensions/models/families.tsx', () => ({ refreshFamilies: async () => {} }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: f.pass,
  DialogContent: f.pass,
  DialogDescription: f.pass,
  DialogTitle: f.pass,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick: () => void }) => {
    const label = renderToStaticMarkup(h('span', null, children))
      .replace(/<[^>]*>/g, '')
      .trim()
    f.buttons.set(label, onClick)
    return h('button', null, children)
  },
}))

import { FamilyMovesDialog, saveWithMoves } from '../../extensions/models/family-moves.tsx'
import type { FamilyMove, SaveFamilies } from '../../extensions/models/refs.ts'

it.each([false, true])(
  'asks by name before saving; move=%s configures only when accepted and reports once',
  async (move) => {
    const moves: FamilyMove[] = [
      { id: 2, title: 'Build the feature', family: 'fast', from: 'acme/old', to: 'acme/new' },
      { id: 3, title: 'Review the feature', family: 'fast', from: 'acme/old', to: 'acme/new' },
    ]
    const args: SaveFamilies = {
      families: { fast: { model: 'acme/new', color: 'amber' } },
      assign: {},
      unpin: [],
    }
    const preview = Promise.resolve(moves)
    f.action
      .mockReset()
      .mockImplementation((ref: { name: string }) =>
        ref.name === 'previewFamilies' ? preview : Promise.resolve(null),
      )
    f.configure.mockReset().mockResolvedValue(undefined)
    f.buttons.clear()
    const saving = saveWithMoves(args)
    await preview
    const html = renderToStaticMarkup(h(FamilyMovesDialog))
    expect(html).toContain('#2 · Build the feature')
    expect(html).toContain('#3 · Review the feature')
    expect(f.action.mock.calls.map(([ref]) => ref.name)).toEqual(['previewFamilies'])
    expect(f.configure).not.toHaveBeenCalled()
    f.buttons.get(move ? 'Save and move' : 'Save, keep open conversations')!()
    await saving
    expect(f.action.mock.calls.filter(([ref]) => ref.name === 'saveFamilies')).toHaveLength(1)
    expect(f.configure.mock.calls).toEqual(
      move
        ? [
            [{ model: { provider: 'acme', modelId: 'new' } }, 2],
            [{ model: { provider: 'acme', modelId: 'new' } }, 3],
          ]
        : [],
    )
    const reports = f.action.mock.calls.filter(([ref]) => ref.name === 'reportFamilyMoves')
    expect(reports).toHaveLength(move ? 1 : 0)
    expect(reports.map(([, report]) => (report as { moves: FamilyMove[] }).moves)).toEqual(
      move ? [moves] : [],
    )
  },
)
