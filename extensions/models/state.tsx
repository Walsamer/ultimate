import { useSyncExternalStore } from 'react'
import { api, getConversation, HttpError, useConversation, useModels, useStore } from '@/sdk'
import type { ModelsResponse, UltimateActions } from '@/sdk'

export type ModelInfo = ModelsResponse['models'][number]
export type ProviderInfo = ModelsResponse['providers'][number]
export type ThinkingLevel = ModelInfo['thinkingLevels'][number]

/** Dialog ids this extension's overlays read with `useDialog`. */
export const dialogs = {
  picker: 'models.picker',
  login: 'models.login',
  condense: 'models.condense',
} as const
/** The thinking popover of conversation `id`'s toolbar: a side chat's has its own, apart from main's. */
export const thinkingDialog = (id: number | undefined) => `models.thinking.${id}`

/** The scoped (or shown) conversation's model and thinking, or those of `target`, and its id to configure. */
export function useCurrentModel(target?: number) {
  const own = useConversation()
  const other = useStore(() => (target === undefined ? undefined : getConversation(target)))
  const { id, agent, loading } = other ?? own
  const models = useModels()
  const ref = agent.model
  const model = models?.models.find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
  )
  return {
    id,
    ref,
    model,
    thinking: agent.thinkingLevel,
    models,
    loading,
  }
}

/** What a switch is waiting on: the route's sentence when the model cannot hold this conversation. */
export type SwitchOutcome = { question?: string }

/**
 * Switch `id` to `model`. A model whose window cannot hold the conversation is refused by the route with a conflict
 * naming what it would condense, so the choice becomes a question rather than a silent condensation: `condense` is the
 * answer, `before` (condense here first) or `anyway`. Every other failure is thrown as it came.
 */
export async function switchModel(
  model: ModelInfo,
  id: number | undefined,
  options: { thinkingLevel?: ThinkingLevel; condense?: 'before' | 'anyway' } = {},
): Promise<SwitchOutcome> {
  try {
    await api.configure(
      {
        model: { provider: model.provider, modelId: model.id },
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(options.condense ? { condense: options.condense } : {}),
      },
      id,
    )
    return {}
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && !options.condense)
      return { question: error.message }
    throw error
  }
}

/** The switch waiting for an answer, kept here so the dialog can outlive the picker that asked. */
export type AskedSwitch = {
  /** The conversation the picker configures; undefined is the shown one. */
  id?: number
  model: ModelInfo
  thinkingLevel?: ThinkingLevel
  /** The route's sentence: what switching now would condense. */
  question: string
}

let asked: AskedSwitch | undefined
const askedListeners = new Set<() => void>()
function setAsked(next: AskedSwitch | undefined) {
  asked = next
  for (const listener of askedListeners) listener()
}
export function useAskedSwitch() {
  return useSyncExternalStore(
    (listener) => {
      askedListeners.add(listener)
      return () => {
        askedListeners.delete(listener)
      }
    },
    () => asked,
  )
}
/** Ask what to do about a switch the route refused, in the picker's place. */
export function openCondense(actions: Pick<UltimateActions, 'open'>, next: AskedSwitch) {
  setAsked(next)
  actions.open(dialogs.condense)
}
export function closeCondense() {
  setAsked(undefined)
}

/**
 * The conversation the picker configures: the one whose toolbar or shortcut opened it, which is a scoped conversation
 * (a side chat) rather than the shown one when opened inside its scope. Undefined targets the shown conversation.
 */
let pickerTarget: number | undefined
const targetListeners = new Set<() => void>()
export function usePickerTarget() {
  return useSyncExternalStore(
    (listener) => {
      targetListeners.add(listener)
      return () => {
        targetListeners.delete(listener)
      }
    },
    () => pickerTarget,
  )
}

function setPickerTarget(target: number | undefined) {
  pickerTarget = target
  for (const listener of targetListeners) listener()
}
export function openPicker(actions: Pick<UltimateActions, 'open'> & { conversationId?: number }) {
  setPickerTarget(actions.conversationId)
  actions.open(dialogs.picker)
}
/** Back to the picker after a login, still configuring the conversation the login started from. */
export function reopenPicker(actions: Pick<UltimateActions, 'open'>) {
  actions.open(dialogs.picker)
}

/** The supported level after `current` in Pi's order, wrapping around, as Pi's Shift+Tab does. */
export function nextThinking(current: ThinkingLevel | undefined, model: ModelInfo) {
  const levels = model.thinkingLevels
  return levels[(levels.indexOf(current ?? 'off') + 1) % levels.length]
}

/** Which provider the login dialog should open on; set just before it opens. */
let loginProvider: string | undefined
const listeners = new Set<() => void>()
/** `actions.conversationId` is the conversation a model picked after this login configures. */
export function openLogin(
  actions: Pick<UltimateActions, 'open' | 'close'> & { conversationId?: number },
  provider?: string,
) {
  setPickerTarget(actions.conversationId)
  loginProvider = provider
  for (const listener of listeners) listener()
  actions.close(dialogs.picker)
  actions.open(dialogs.login)
}
export function useLoginProvider() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => loginProvider,
  )
}

/** 128k, 1M: a context window. */
export function formatWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}

/** Dollars per million tokens, compact: 0.1, 2, 12.5. */
export const price = (value: number) => (value === 0 ? '0' : String(+value.toFixed(3)))

/** How a provider is configured, for labels: `stored`, `env`, … */
export function authLabel(provider: ProviderInfo | undefined) {
  if (!provider?.status.configured) return undefined
  const { source, label } = provider.status
  if (label) return label
  if (source === 'environment') return 'env'
  if (source === 'models_json_key' || source === 'models_json_command') return 'models.json'
  return source ?? 'configured'
}
