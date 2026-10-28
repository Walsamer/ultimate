/** Live voice actions and the standing Voice conversation. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** `gpt-live`: GPT-Live's WebRTC audio; `local`: this Mac's open models through the speak extension. */
export type VoiceEngine = 'gpt-live' | 'local'
export type VoiceStatus = { engine: VoiceEngine } & (
  | { available: true }
  | { available: false; reason: string }
)
export type VoiceSession = {
  phase: 'started' | 'ended'
  at: number
  seconds?: number
}
/**
 * One line of the Voice transcript. `user`: the cleaned request forwarded to @ultimate;
 * `live`: GPT-Live's backchannels; `ultimate`: Voice's speech, `re` the forwarded line it answers;
 * `notice`: an unanswered request; `note`: quiet context sent to GPT-Live. `at`: when a forwarded line went out.
 */
export type VoiceLine = {
  role: 'user' | 'live' | 'ultimate' | 'notice' | 'note'
  text: string
  forwarded?: true
  at?: number
  re?: number
  source?: { conversation: number; entry: number }
  speech?: true
}
export type VoiceUtterance = { text: string; line: number }
/**
 * What Voice was given at a session's start: the project memory, the user's recent requests to @ultimate and the open
 * branches, as `text`. Only the newest one reaches the model, at its place in the transcript, or after the summary once
 * compaction cut it. `error`: it could not be put together, and Voice started without one.
 */
export type VoiceContext = {
  text: string
  memories: number
  requests: number
  branches: number
  tokens: number
  at: number
  /** How long it took to put together. */
  ms?: number
  error?: string
  /** Placed again after a compaction cut it. */
  again?: true
}
/** @ultimate's full answer to forwarded line `re`, as Voice received it; `source` is the answer in @ultimate. */
export type VoiceAnswer = {
  text: string
  re: number
  source?: { conversation: number; entry: number }
}

/** No arguments → API key availability, or a reason explaining how to enable it. */
export const StatusAction = actionRef<null, VoiceStatus>('voice-live', 'status')
/** `{ sdp }` offer → `{ sdp, conversation }` answer; creates a billable WebRTC session. */
export const StartAction = actionRef<{ sdp: string }, { sdp: string; conversation: number }>(
  'voice-live',
  'start',
)
/**
 * How long the local engine waits before a line is done. `cutMs` of quiet sends the words so far to Smart Turn; a
 * sentence it calls finished goes at once, an unfinished one is held `holdMs` more for the rest, then sent as it is.
 */
export type VoicePause = { cutMs: number; holdMs: number }
/** Start a local-engine session: no audio leaves the Mac, so there is no SDP; the brief is placed as for GPT-Live. */
export const StartLocalAction = actionRef<
  null,
  { conversation: number; pause: VoicePause; turns: 'auto' | 'dictation'; endPhrases: string[] }
>('voice-live', 'startLocal')
/**
 * A finished user transcript → input to the Voice agent, steering while busy. `raw`: what the transcriber heard before
 * the lexicon put the user's terms right. `unsure`: the turn ended on silence alone, with signs it was unfinished.
 */
export const HeardAction = actionRef<
  { text: string; raw?: string; unsure?: boolean },
  Record<string, never>
>('voice-live', 'heard')
/** GPT-Live's own line or a notice. The user's lines use heard instead. */
export const LogAction = actionRef<{ role: 'live' | 'notice'; text: string }, { line: number }>(
  'voice-live',
  'log',
)
/** Record the ended divider after closing the data-channel session. */
export const EndAction = actionRef<{ seconds?: number }, Record<string, never>>('voice-live', 'end')
