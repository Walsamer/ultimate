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
 * (DeepSeek's "Insufficient Balance"), a gateway's exhausted token allocation for the account (the LLM hub answers
 * 429 "You've reached your maximum token allocation"), or a rate limit Pi already spent its retries on (`rateLimited`).
 * A model layer moves such a conversation to another model. Capacity (529, overloaded), billing notices and network
 * errors are not: another model would not help, or the login itself decides the bill.
 */
export const outOfQuota = (error: string) =>
  /quota|usage[_\s-]?limit|insufficient[_\s-]?balance|maximum.{0,16}allocation|token allocation/i.test(
    error,
  ) || rateLimited(error)

/**
 * Whether the provider has no such model, no permission for it or nothing left to serve it with, so the same request on
 * this model keeps being refused however often it is sent: an unknown, retired, disabled or unsupported model id, a
 * model the login may not use, or a gateway that names the model's own limit. Two faults on this side are not one of
 * these, and another model does not fix them: an invalid model configuration, and Pi's "Model missing/missing is not
 * available" for a model this home does not know at all.
 */
const unsupported = (error: string) =>
  /model.{0,24}(?:not found|not supported|unsupported|unknown|does not exist|doesn't exist|decommissioned|deprecated|retired|disabled|blocked|not permitted)|unsupported model|no such model|model_not_found|no allocation|not authorized.{0,40}model/i.test(
    error,
  )

/**
 * Whether the provider failed on its own side and Pi's retries did not fix it: 5xx, overloaded, unavailable, a stream cut
 * off mid-answer. The model may be broken or not deployed, and another one can serve the same request.
 */
const serverFailed = (error: string) =>
  /(?<![a-z0-9])(?:500|502|503|504|529)(?![a-z0-9])|overloaded|server[\s-]?(?:error|busy)|internal[\s-]?(?:server[\s-]?)?error|service[\s-]?(?:is[\s-]?)?(?:temporarily[\s-]?)?unavailable|stream was interrupted|upstream.{0,40}(?:failed|error)/i.test(
    error,
  )

/**
 * Whether a failed run should move on to the family's next model instead of stopping: the account is spent
 * (`outOfQuota`), this model is not served here (`unsupported`), or the provider kept failing on its side after Pi's
 * retries (`serverFailed`). Another model would serve this request, so a chain walks one step further.
 *
 * Deliberately not: a broken login (the user has to log in again; the fallback's no-login check moves a conversation
 * only when the whole login is gone), a transport error on this machine (fetch failed, a reset connection, a timeout:
 * another model reaches the same broken network), an invalid request or a context overflow (another model with the same
 * window refuses it too), and a billing notice (the login itself decides the bill). Those stop and report.
 */
export const modelBlocked = (error: string) =>
  outOfQuota(error) || unsupported(error) || serverFailed(error)

/**
 * Whether the refusal is the provider's own side rather than the account: a failure that may pass on its own, so the mark
 * it writes leaves the model alone for a short while instead of a full cooldown.
 */
export const transient = (error: string) => serverFailed(error) && !outOfQuota(error)
