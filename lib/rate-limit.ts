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
