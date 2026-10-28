/** The local engine's turn-taking timings. Browser-safe. */
import type { VoicePause } from './refs.ts'

/**
 * `voiceLive.pause`: `relaxed` (default) gives thinking pauses room, `snappy` is the old timing. `cutMs` of quiet ends
 * a line the turn rules trust as finished; a line with any doubt is held `holdMs` more.
 */
export const PAUSES: Record<'relaxed' | 'snappy', VoicePause> = {
  relaxed: { cutMs: 900, holdMs: 12_000 },
  snappy: { cutMs: 400, holdMs: 1600 },
}

/** A forwarded request still unanswered gets a spoken "still on it" this long after it went out, then every `NUDGE_REPEAT_MS`. */
export const NUDGE_FIRST_MS = 30_000
export const NUDGE_REPEAT_MS = 60_000
