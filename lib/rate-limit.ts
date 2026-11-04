import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'

/**
 * Whether a model error is a rate limit Pi retries: HTTP 429, "rate limit", "too many requests". Retrying sooner only
 * hits the limit again, so Ultimate pauses until the user presses Play, and the held run continues through Pi's retry.
 * Quota, usage-limit and billing errors are on Pi's no-retry list: they end the run at once and fail as usual.
 * Overloaded servers (529) are the provider's capacity, not the account's limit.
 */
export const rateLimited = (error: string) =>
  /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/i.test(error) &&
  isRetryableAssistantError({ stopReason: 'error', errorMessage: error } as AssistantMessage)

/**
 * Whether the login's account is spent rather than the provider busy or the login broken: OpenAI's `insufficient_quota`,
 * a provider's "quota"/"usage limit" refusal (Codex says "You've hit your usage limit"), an empty prepaid balance
 * (DeepSeek's "Insufficient Balance"), or a rate limit Pi already spent its retries on (`rateLimited`). A model layer
 * moves such a conversation to another model. Capacity (529, overloaded), billing notices and network errors are not:
 * another model would not help, or the login itself decides the bill.
 */
export const outOfQuota = (error: string) =>
  /quota|usage[_\s-]?limit|insufficient[_\s-]?balance/i.test(error) || rateLimited(error)

/** Seconds per unit a refusal writes its reset in. */
const UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
}

/** No quota window is longer than a month, so a moment further out is a misread rather than a reset. */
const LONGEST_RESET_MS = 31 * 86_400_000

/**
 * When a refusal says its limit resets, or undefined when it names no time — which is what most refusals do: the one
 * this machine sees from Codex ("Codex error: The usage limit has been reached") names none. Two shapes are read: a
 * timestamp the words of a reset introduce (`resets at 2026-11-05T12:00:00Z`), so a body carrying some other moment
 * cannot be mistaken for one, and a duration, either after the words a provider uses (`try again in ~42 min`, Pi's own
 * sentence when Codex's body carries `resets_at`; `try again in 3 days`; `retry after 1200 seconds`), as
 * `resets_in_seconds: 1200`, or as `retry-after: 1200` (which is seconds, quoted or not). A moment already past, or
 * further away than `LONGEST_RESET_MS`, counts as no time at all.
 */
export function resetAt(error: string, now = Date.now()): number | undefined {
  const stamped =
    /(?:try again|retry|resets?|available again)[^\n]{0,24}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
      error,
    )
  const seconds = /resets?[_ ]?in[_ ]?seconds?["']?\s*[:=]?\s*(\d+)/i.exec(error)
  const header = /retry[-_\s]?after["':\s]{0,6}(\d+)/i.exec(error)
  const named =
    /(?:try again|retry|resets?|available again)[^.;\n]{0,24}?(\d+(?:\.\d+)?)\s*([a-z]+)\b/i.exec(
      error,
    )
  const unit = named ? UNITS[named[2].toLowerCase()] : undefined
  const at = stamped
    ? Date.parse(stamped[1])
    : seconds
      ? now + Number(seconds[1]) * 1000
      : header
        ? now + Number(header[1]) * 1000
        : named && unit !== undefined
          ? now + Number(named[1]) * unit * 1000
          : undefined
  if (at === undefined || !Number.isFinite(at)) return undefined
  return at > now && at - now <= LONGEST_RESET_MS ? at : undefined
}
