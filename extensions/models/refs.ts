/**
 * Models in the browser: provider login flows, which a conversation's login dialog follows, and the actions that
 * start, answer and cancel them or log out, and the event of a completed login or logout. Browser-safe.
 */
import type { AuthEvent, AuthPrompt, AuthType, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** One login flow as the browser sees it. Answers and credentials never enter it. */
export type LoginFlow = {
  provider: string
  type: AuthType
  status: 'running' | 'complete' | 'cancel' | 'error'
  /** The prompt waiting for an answer, without its `signal`. */
  prompt?: AuthPrompt
  events: AuthEvent[]
  error?: string
}

/** The login flows started from a conversation, by flow id, on that conversation; finished ones are kept for a while. */
export const LoginDoc = docRef<{ flows: Record<string, LoginFlow> }>('models.login')

/** `{ provider, type }` → `{ flowId }`: start logging in to `provider` for the calling conversation. */
export const LoginAction = actionRef<{ provider: string; type: AuthType }, { flowId: string }>(
  'models',
  'login',
)
/** `{ flowId, value }` → null: answer the flow's pending prompt; an empty answer is allowed. */
export const AnswerAction = actionRef<{ flowId: string; value: string }, null>('models', 'answer')
/** `{ flowId }` → null: cancel a running login flow. */
export const CancelAction = actionRef<{ flowId: string }, null>('models', 'cancel')
/** `{ provider }` → null: remove the provider's stored credential, which Pi shares. */
export const LogoutAction = actionRef<{ provider: string }, null>('models', 'logout')

/**
 * A `models.fallback` entry: the conversation's model (`provider/id`) either had no login here or refused its last
 * request in a way another model would not share, so its next run switched to `to`: the same model on another provider,
 * the model its definition runs on (`pin`), a fallback its family names (`family`, the first entry of an ordered list
 * that is usable) or the configured default (`default`). With `reason: 'quota'` the account behind the login was spent
 * and with `reason: 'refused'` the provider would not serve that model (unknown or retired there, no permission or
 * allocation, or its own side failing after Pi's retries); without `to` nothing could replace it (a subscription only
 * moves to another subscription, unless its family's own fallback names a billed login) and it kept its model and needs
 * the user. `billed` marks a move that left a subscription login for one billed per token, which only a family's
 * configured fallback may do. With `reason: 'reset'` the quota that refused it is back, and the conversation returned to
 * `to` (the model its family names) by itself.
 */
export type Fallback = {
  from: string
  to?: string
  reason: 'same' | 'pin' | 'family' | 'default' | 'quota' | 'refused' | 'none' | 'reset'
  /** The move crossed from a subscription to a login billed per token; the card says so. */
  billed?: true
  /** When the refused provider may work again (ms): the reset it named, or the retry interval. Only the review family
   * records it, since only `review` returns to its family's model by itself (`switchback.ts`). */
  until?: number
}

/**
 * A login or logout of model provider `provider` completed through Ultimate; react to it to drop what you knew about
 * that provider's credentials (health resets its record to unknown).
 */
export const LoginChanged = defineEvent<{ provider: string }>('models.login-changed')

/** One model family as the Agents panel shows it. */
export type FamilyView = {
  name: string
  color: string
  /** `provider/id`; unset for a default family that follows Pi's default model (`follows`). */
  model?: string
  thinking?: ModelThinkingLevel
  /** `provider/id` a conversation on it moves to when its model's provider has no login here or runs out of quota;
   * an ordered list walks one step per failure. */
  fallback?: string | string[]
  /** Pi's default model and thinking, which a default family without its own runs. */
  follows?: string
  followsThinking?: ModelThinkingLevel
  builtin: boolean
  /** The project's settings set something of it, over the user's. */
  project?: true
}

/** Something that calls a model: an agent definition (`agent/<name>`) or a feature (`summaries`, `preview`). */
export type FamilyUser = {
  id: string
  kind: 'agent' | 'feature'
  label: string
  description: string
  /** The family it runs on; undefined while a model is pinned (`pinned`). */
  family?: string
  /** The family its definition names, or the feature's default. */
  natural: string
  /** A model it pins (`provider/id`, or `off`), and where: a definition file or a settings key. */
  pinned?: string
  pinnedIn?: string
  /** A feature the project's settings assign or pin, so the user's choice does not apply. */
  project?: true
  source?: 'builtin' | 'user' | 'project'
}

export type FamiliesView = {
  /** In display order: built-ins, then the user's. */
  families: FamilyView[]
  users: FamilyUser[]
  /** The saved feature assignments; the project's team settings may add more. */
  assign: Record<string, string>
  /** Whose families these are: this project's own, the most recently saved ones, or the built-in ones. */
  from: 'project' | 'recent' | 'builtin'
  /** Settings problems: a `modelFamilies` layer that fails to parse counts as empty. */
  errors: string[]
}

/** No arguments → the families and who runs on which. */
export const FamiliesAction = actionRef<null, FamiliesView>('models', 'families')

export type SaveFamilies = {
  families: Record<
    string,
    { model?: string; thinking?: ModelThinkingLevel; color: string; fallback?: string | string[] }
  >
  /** Which family each feature (`summaries`, `preview`) runs on; agents keep theirs in their definitions. */
  assign: Record<string, string>
  /** Features whose user-settings pin (`summaryModel`, `instance.model`) a family replaces. */
  unpin: string[]
}
/**
 * Save this project's families, also as the most recent ones new projects start from. Conversations started after it
 * use them; open ones keep their model until `previewFamilies` names them and the user agrees to move them.
 */
export const SaveFamiliesAction = actionRef<SaveFamilies, null>('models', 'saveFamilies')

/**
 * One open conversation a family change would move: its id and title, the family whose model changed, and the model it
 * runs now → the one its family names after the save. A conversation whose definition pins a model is never one.
 */
export type FamilyMove = {
  id: number
  title: string
  family: string
  from: string
  to: string
}

/**
 * The same save's `SaveFamilies` arguments → the open conversations it would move, and nothing else: it writes nothing
 * and changes no agent, so the user can be asked before anything happens. A save with no moves can apply at once.
 */
export const PreviewFamiliesAction = actionRef<SaveFamilies, FamilyMove[]>(
  'models',
  'previewFamilies',
)

/**
 * `{ requestId, moves }` → null: one passive `models.family-moved` entry on the project root naming every conversation
 * that was moved, written once per `requestId`.
 */
export const ReportFamilyMovesAction = actionRef<{ requestId: string; moves: FamilyMove[] }, null>(
  'models',
  'reportFamilyMoves',
)

/**
 * The automatic moves of refused models, grouped on the root: one entry per outage rather than one per conversation
 * (`auto-moves.ts`, which moves a conversation off a spent provider). `from` is the model that refused, `until` when it
 * may work again, and `moves` the conversations the group carried.
 */
export type AutoMoves = {
  groups: Record<string, { from: string; until: number; moves: FamilyMove[] }>
}
