# Model routing audit: free models, long conversations, and what a model switch costs

A read-only audit of how Ultimate chooses a model, what happens to a long conversation when that model gets a smaller
context window, and what could route more work onto the free Telekom LLMHUB models without spending paid tokens by
accident. It was prompted by two things: about €20 of unexpected DeepSeek spend after a model-family change, and a
specific loss — long-running conversations were moved onto free 128K-context models, did not fit, and their working
state was condensed away.

Line numbers are **`main` at `d784e882`** (the ordered-fallback-list landing), which is what this machine runs. Where a
statement rests on reading code rather than on an observed behaviour it says "inference". Nothing was changed: no
settings, no code, no restart. Probes were bounded and free (one `GET /v2/models`, one 1-token completion); no paid
request was made for this audit.

One rule was added by the user while the audit ran, and it outranks the cooldown design that would otherwise follow
from the code: **a free model that hits its quota stays disabled until the user enables it again.** It is carried
through section 4 (the disable rule at the end of it) and P1.

## 1. Executive summary

1. **The invariant does not hold, and it is violated on the next turn, not at the moment of the switch.** Picking a
   smaller-window model writes one field (`agent.model`) and nothing else — no check, no prompt, no card
   (`server/api.ts:674-712` → `pi-durable/dist/harness/agent.js:63-66`). On the next request Pi recomputes the
   compaction threshold from the **destination** model's window (`.../harness/generation.js:74`, `:234-241`) and starts
   a blocking compaction **before** sending (`generation.js:76-84`). The switch is silent; the condensation that follows
   is the first thing the user can see.
2. **Nothing is deleted, but the model's working state is replaced by a summary.** Compaction appends a summary entry
   carrying a `head` pointer (`.../harness/compaction.js:371-387`); the context view then starts after that head
   (`.../harness/context.js:70-79`). Earlier entries stay in storage and still render above the card
   ("Earlier messages remain available above", `web/src/app/transcript.tsx:1257-1281`). There is no undo: nothing
   restores a head marker.
3. **This is not a hypothetical risk on this machine; it is the default path.** `default`, `lead`, `fast` and `design`
   all name `llmhub/GLM-5.3` as their fallback (`.ultimate/settings.json`), so an ordinary DeepSeek quota refusal moves
   @ultimate (389,570 tokens today) onto a model declared at 128,000 and condenses it on the next turn.
4. **Measured exposure:** of the 53 conversations of this project that carry a context document (56 exist), **17 are
   already past the 112k blocking threshold** and 15 past 128k (median 84,657; p90 229,272; max 389,570). A family change
   onto a free hub model today would condense a third of this project's history.
5. **The 128K is not a fact about the hub, it is Pi's schema default.** The hub's `/v2/models` returns id, object,
   created and owner only — no context length, no limits — and `~/.pi/agent/models.json` declares neither window nor
   max tokens for either hub model, so `contextWindow: 128000` and `maxTokens: 16384` come from
   `pi-coding-agent/dist/core/model-config.js:44-45`. Every routing decision below rests on a number nobody measured.
6. **A switched-in model can wedge the conversation.** The summarizing request carries the whole pre-cut transcript
   serialized, truncated only per tool result at 2,000 chars (`compaction.js:11`, `:309-346`) and is sent with no window
   check (`:129`). #40's newest 600 messages alone serialize to 545,187 chars ≈ 136k tokens: on a 128k window that
   request cannot fit, the compaction fails, and the run fails with "Compaction failed" (`generation.js:39-56`). The
   conversation is then stuck until someone moves it back to a big model or runs a compaction there.
7. **The free tier is not free of interruption cost.** During this audit — about an hour — the host was paused **four
   times** by the same cause: "llmhub rate limited GLM-5.3" (14 m, 17 s, 4 m, 50 s), from two `scout` subagents whose
   family is `tiny` (GLM-5.3). Each pause held the whole scheduler, including this paid DeepSeek run
   (`extensions/pause/README.md:10-18`). That is the same shape as the 7-day measurement in #19213 (four hub 429s, two
   holds of 2 h 22 m and 1 h 15 m) — the frequency scales with how many free agents run at once.
8. **The hub is not misconfigured.** A 1-token `GLM-5.3` completion returned 200 while the pauses were happening, and
   its response carried no rate-limit header — only CloudWAF cookies, a request id and cache directives. The refusals
   are load, not a broken login or a spent quota, and nothing tells the client where a limit is before it is refused.
9. **Paid spend is recorded, per conversation and per model, and nothing acts on it.** `pi.usage` totals cost per
   conversation (`.../harness/usage.js:3-39`); this project's books show **$13.13** across 51 conversations and 541.9 M
   tokens, all on `deepseek/deepseek-flash`, with @ultimate alone at $4.04. It is displayed (status line project totals,
   info panel) and bounded by nothing.
10. **The model map is not a decision, it is a draft.** It changed three times in one day: `5381f147` (everything on
    Codex Luna, 09:08), `d5ba1a34` (free hub for volume, Codex for planning, 22:59), `a26bc673` (paid Flash drives the
    work again, free hub for the small tier, 10:02 next day). Any routing rule written here has to survive another such
    edit without being re-derived; that is the argument for a check in code (P0) over a better map in settings.

## 2. Current state

### 2.1 How a model is chosen

| Step             | Where                                            | What it decides                                                                                    |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Definition file  | `agents/*.md`, `<project>/.ultimate/agents/*.md` | `model:` (a pin) or `family:`, plus `thinking:`                                                    |
| Family           | `lib/families.ts:212` (`definitionRuns`)         | own pin → its `family` → `default`; own thinking wins                                              |
| Family's model   | `lib/families.ts:32`, `:162` (`mergeFamilies`)   | built-ins, then `~/.ultimate/model-families.json` (`recent`), then the project's `modelFamilies`   |
| Spawn resolution | `lib/agents.ts:131-156` (`definitionAgent:151`)  | `previewModel() ?? override ?? pin ?? parent.model`; a pin is used only if it has a login (`:150`) |
| Default model    | `lib/agents.ts:76-87` (`defaultModel`)           | the default family's model, else Pi's default, else the first model with a login                   |
| @ultimate's root | `server/harness.ts:281`, `:291`                  | the default family's model, re-resolved **every time the home opens**                              |

A conversation's model is then a stored field (`AgentDoc.model`), read at every request
(`.../harness/generation.js:33-36`). That single fact explains most of what follows: a family change is a _template_ for
new conversations, and a conversation's model is whatever was last written to it.

### 2.2 Which conversations adopt a family change

- **New conversations** — branches, side chats, the lander, a subagent at spawn — yes: `definitionAgent` resolves the
  family when the child is created (`lib/agents.ts:151`).
- **Open conversations, none.** "A change applies to conversations started after it; open ones keep their model"
  (`extensions/models/families.ts:5-6`, `extensions/models/README.md`).
- **@ultimate's root**: re-resolved on each open (`server/harness.ts:291`), so a family change reaches it at the next
  start, not at the next turn.
- **Previews**: every agent of an `instance start` runs on `ULTIMATE_MODEL` (`lib/agents.ts:52-60`), set from
  `instance.model` (`extensions/instance/server.ts:40-62`); it wins over everything, including a pin.
- **Automations**: each fired run creates a new conversation copying the root agent, with an optional per-automation
  `model` pin (`extensions/automations/server.ts:313-318`).

So the incident was not a family change. Families would have left the long conversations alone. The long conversations
were moved either by the model picker (⌘K **Pick a model**, `server/api.ts:674-712`) or by a fallback
(`extensions/models/fallback.ts:100`) — both of which write `agent.model` on the open conversation.

### 2.3 What a smaller window does — the trace

**Moment 1, the switch.** `configure` is `applyChange(doc, change)` and nothing beside it
(`.../harness/agent.js:63-66`). The API route only checks that the model is available and clamps the thinking level
(`server/api.ts:674-712`). The fallback path is the same write, plus a thinking clamp
(`extensions/models/fallback.ts:100-104`). Neither reads a context window; `grep contextWindow` over `extensions/`,
`lib/`, `server/` and `web/src` finds display uses only (`extensions/models/picker.tsx:91`,
`extensions/conversations/context.ts:66`, `extensions/status-line/web.tsx:283`, `extensions/info/web.tsx:294`).

**Moment 2, the next request.** In `prepare` the generation resolves the model it is about to ask
(`generation.js:33-36`) and computes the threshold from _that_ model's `contextWindow`:

```
tokens  > contextWindow - reserveTokens            → blocking, compact before sending
tokens  > blocking - backgroundTokens              → background compaction starts beside the request
```

(`generation.js:234-241`; the policy is `compactionPolicy(settings, model)` at `compaction.js:195-208`, overridden per
model in `server/harness.ts:68-84`). With no override, the policy is Pi's default — reserve 16k, keep 20k, background
32k, "which suit a ~200k window" (`docs/settings.md:38-45`, `server/harness.ts:60-67`). So a destination declared at
128k blocks above 112k, and `deepseek/deepseek-flash` at 1M blocks above 984k — a 9× difference in when the user's
transcript gets condensed, decided by no one.

A blocking compaction holds the run (`generation.js:76-84`), summarizes everything before the cut with
`maxTokens = min(0.8 × reserveTokens, model.maxTokens)` (`compaction.js:95`) — 12,800 tokens on the 128k destination
— and appends one `CompactionEntry` whose `head` is the first kept entry (`compaction.js:371-387`). The context view
then starts after that head (`context.js:70-79`), keeping about `keepRecentTokens` (20k) of recent context verbatim.

**If the summarization itself does not fit**, the compaction fails (`compaction.js:298-308`, `:152`) and `prepare`
fails the run with `Compaction failed: …` (`generation.js:39-56`). A provider-side overflow is the other route in
(`generation.js:406-424`: one compaction, then the run fails if that fails too). Measured lower bound for @ultimate: the
newest 600 messages serialize to 545,187 characters (tool results truncated at 2,000 chars, `compaction.js:11`,
`:344`), ≈136k tokens, against a 128k window — it would not fit. Whether a given conversation fits depends on how much
of it is text rather than truncated tool output; that is checkable per conversation and is not checkable in general.

### 2.4 What survives a compaction

- **The entries.** Never rewritten. They are what "Earlier messages remain available above" points at
  (`web/src/app/transcript.tsx:1257-1281`), and the transcript pages backwards past the head when a compaction lands
  (`transcript.tsx:303-312`).
- **The model's working state.** Gone: replaced by the summary plus the kept tail. This is the loss the user described
  — not data loss, state loss.
- **A way back.** None. Nothing in the codebase restores a previous head marker; `extensions/conversations/compactions.ts`
  only emits `conversations.compacted` for each summary placed. The recoveries are to move back to a wide model,
  re-read the conversation (codemode `ultimate.entries` with `before:`), or start a fresh session with a brief.
- **Checkpoints and chapter/tree summaries are not conversation snapshots.** Task checkpoints are Pi's durability state
  for a run in flight (`.../harness/*.js`, per-task `checkpoint`), and a context document is written with
  `checkpointWhen: () => false` precisely so each commit does not snapshot it
  (`extensions/conversations/api.ts:99-107`). Chapter and root summaries are the lineage tally — text about a project,
  not a way to reconstruct a transcript. None of them is a fallback for a condensed conversation.

### 2.5 Where the map stands, and why it is fragile

Today (`.ultimate/settings.json`, mirrored in `~/.ultimate/model-families.json` under `recent`, and again per project
for another project on this machine):

| family             | model                      | window    | fallback                   |
| ------------------ | -------------------------- | --------- | -------------------------- |
| default            | `deepseek/deepseek-flash`  | 1,000,000 | `llmhub/GLM-5.3` (128,000) |
| lead, fast, design | `deepseek/deepseek-flash`  | 1,000,000 | `llmhub/GLM-5.3`           |
| tiny               | `llmhub/GLM-5.3`           | 128,000   | `deepseek/deepseek-flash`  |
| review             | `openai-codex/gpt-6.1-sol` | 500,000   | `deepseek/deepseek-flash`  |

Three consequences worth stating plainly:

1. Every big family falls back **down** a window, with no guard (finding 1/3). This is the destructive edge, and it is
   one settings edit away from being fixed (section 6).
2. `~/.ultimate/settings.json` pins `summaryModel` to `deepseek/deepseek-flash:low`, so titles, summaries, reply
   summaries and tree abstracts are **paid** and a pinned summary model never falls back
   (`extensions/conversations/summary-model.ts:104-110`). The `tiny` family's move to the free hub did not move
   them.
3. `fast: true` on `worker`, `dream-pass` and two reviewers buys nothing here: the priority tier exists only for
   `openai/` and `openai-codex/` models (`extensions/fast/README.md:1-16`).

The map is three days old and has been rewritten three times. Nothing in the code notices when a family's model and the
work its conversations actually do stop matching — which is why the fixes below are guards and marks, not a better map.

## 3. Roles, models and where a fresh session beats a long one

Measured with `conversations.context` on the conversations named (tokens actually sent with the last request) and
`pi.usage` (cost recorded so far).

| Role                 | Family                        | Model today                                   | Measured context                     | Grows                                   | Lives         | Tool calls             | Cost of an interruption               | Fresh session?                       | Verdict                                         |
| -------------------- | ----------------------------- | --------------------------------------------- | ------------------------------------ | --------------------------------------- | ------------- | ---------------------- | ------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| @ultimate            | default                       | paid Flash 1M                                 | 389,570 (39%)                        | days, monotonic                         | whole project | heavy, nested          | very high — it holds the tree's state | no (it is the tree)                  | **strong model, wide window, non-negotiable**   |
| Branch coordinator   | lead / default                | paid Flash 1M                                 | 89,877 (this one)                    | per branch, to ~300k (`#13069` 303,589) | hours to days | heavy                  | high — a branch's plan lives here     | rarely; a landing is the natural end | **strong model, wide window**                   |
| Worker               | fast                          | paid Flash 1M                                 | up to 240,795 (`#14349`)             | task-shaped                             | one task      | moderate               | moderate — a worktree keeps the work  | yes, if the brief is written         | strong model; free only with a bounded handoff  |
| Designer             | design                        | paid Flash 1M                                 | no run among the 56; inference ~100k | per preview round                       | hours         | moderate + screenshots | moderate                              | yes, per round                       | strong model                                    |
| Reviewer (team)      | review                        | Codex Sol 500k                                | 22k–148k (`#15240`–`#15311`)         | one range                               | minutes       | read-only              | low — the range is immutable          | yes, naturally                       | strong model, **bounded by design**             |
| Scout                | tiny                          | **free GLM 128k**                             | 55,431 (43%)                         | fast                                    | minutes       | lots of reads          | low                                   | yes, by definition                   | **safe on free** — the best fit in the table    |
| Dream-pass           | fast                          | paid Flash                                    | 50,595                               | one pass                                | one pass      | read-only              | low                                   | yes                                  | **safe on free**                                |
| Watcher              | tiny                          | **free GLM 128k**                             | small                                | slow                                    | resident      | script + reads         | low                                   | yes                                  | **safe on free**                                |
| Sketch               | tiny (via `agents/sketch.md`) | **free GLM 128k**                             | one call                             | —                                       | one call      | none                   | none                                  | yes, always                          | free                                            |
| Summaries            | `summaryModel` pin            | **paid Flash :low**                           | a few k                              | —                                       | one call      | none                   | none — re-runs                        | always                               | free is defensible, see §4                      |
| Previews / instances | `instance.model`              | unset → previews family (`fast` = paid Flash) | small, seeded                        | per run                                 | minutes       | full                   | none                                  | yes, always                          | free is fine; it runs every agent on one model  |
| Automations          | root's agent, or a pin        | paid Flash                                    | small per fire                       | per fire                                | each fire new | varies                 | low                                   | yes, each fire                       | free for script-driven ones, else leave         |
| Lander               | default                       | paid Flash                                    | small (checks own it)                | —                                       | one landing   | via checks             | low                                   | n/a                                  | leave on the strong model: it is the final gate |

**Headline split.** Two roles are structurally long-lived and hold a tree's working state: **@ultimate and the branch
coordinator**. They need the widest window and a strong model, and they are the two that must never be handed a smaller
window. Six roles are **bounded and re-created** — scout, dream-pass, watcher, sketch, reviewer, preview/automation runs
— and they are genuinely safe on a free 128k model, because none of them is where work accumulates. `worker` and
`designer` sit in between: they _should_ be bounded, and the measurements say they are not (`#14349` at 240,795 tokens
is a worker), so they need either the strong model or a discipline the tooling does not yet impose.

**Where a bounded handoff is better than continuing.** Today the compaction itself is the only "handoff", and it is
implicit, lossy and unannounced. The explicit form is a fresh conversation with a written brief — and the pieces already
exist: `extensions/codemode` reads any conversation (`ultimate.entries`), the `note`/`message` tools carry text between
conversations, worktrees keep the code state, and a `pi.reset` divider already marks a handoff in the transcript
("context reset · handoff", `web/src/app/transcript.tsx:1099`). A handoff should be chosen for a task boundary
(worker finishing, branch landing), never for a window boundary: a window boundary is exactly when the work is least
summarizable.

## 4. Routing decisions

Scenarios A–G as asked. For each: what should happen, what happens today, and what is genuinely missing. The user's new
rule — _a free model that hits its quota stays disabled until the user enables it again_ — is carried into A, B, C and
E.

**A. A new task is dispatched.** The definition's family decides, once, at creation. Today: correct and cheap
(`lib/agents.ts:151`). Missing: nothing mechanical. What is missing is _fit_ — a worker conversation is allowed to grow
to 240k on a 1M model because nothing tells it to stop and hand off. That is a prompt/documentation gap, not a router.

**B. A rate limit (429) arrives.** Today: `lib/rate-limit.ts:13-19` recognises it, the pause extension holds the whole
scheduler before Pi's retry backoff (`extensions/pause/README.md:12-14`), and it waits for Play. That is right for a
**paid** provider, where every retry is money, and wrong for a **free** one, where the retries cost nothing: this audit
was paused four times in about an hour by two free scouts, holding this paid run each time. Should be: on a free model,
do not pause the host — record the disable below and let that one run fail into the chain, whose next step is chosen
once. Reuse: the pause extension decides
by provider; the piece that knows free from paid is the model's own cost (`cost.input + cost.output === 0`, the same
test `fallbackModel` uses at `extensions/conversations/summary-model.ts:74-83`, `:80-81`). Missing: that distinction, and
per-model marks.

**C. The model is unavailable, or its login is gone.** Today: handled well and quietly — only certain evidence moves it
(a fresh `checkAuth` agreeing, `extensions/models/fallback.ts:56-59`), otherwise the model stays and the request fails
with its own error. Keep as is.

**D. A fallback would land on a smaller window.** Today: it just does (finding 1). Should be: a candidate that cannot
hold the conversation's current context is **skipped**, exactly like a spent provider is skipped today
(`fallback.ts:65-66`, `:81-90`), and if no candidate holds it the conversation keeps its model and the card asks. A
user _choice_ to move to a smaller model is allowed but must say what it will condense, and should condense on the
current model first (P0, section 6). Missing: the window comparison, and one card.

**E. Every free model in the list is disabled or unusable.** Should be: **stop**, with one card naming the disabled
models and their Enables — do not spend. Today the chain has an unconditional last step, the default family's model
(`fallback.ts:86-87`), which on this machine is paid; so "all free are down" silently becomes "pay". Missing: that last
step should be taken only when the conversation's family _declares_ it. This is the single most important change after
P0, because it is where a free-tier outage turns into a bill.

**F. Codex quota runs out (or Codex is simply failing).** `review` is the only family on a subscription
(`openai-codex/gpt-6.1-sol`), and its fallback is paid DeepSeek — allowed today only because a family fallback is the
one step that may cross into a billed login (`extensions/models/fallback.ts:65-66`, landed in `b811cb64`). Codex is
currently failing with "request failed" _without_ a quota signal, which is not `outOfQuota`, so nothing moves and the
run fails once (`extensions/watchdog/server.ts:111-116`). **Recommendation: hold and wait, do not spend.** Reasons: a
review is repeatable against an immutable commit range, so a delayed review costs nothing but time; a Codex request is
already paid for by the subscription, while a fallback to DeepSeek bills every token of a review (its input rate of
$0.30/M is cheaper per token, but it is money where Codex is none); and the failure mode of a silent switch is a review
that runs on a weaker model without anyone knowing. Keep the existing "needs you" card, and do not give `review` an
automatic paid step.

**G. Repeated or nested failures.** Today: one continuation per failed run through the watchdog
(`extensions/watchdog/server.ts:111-116`, `extensions/pause/README.md:18`), `watchdog.failure` cards naming the child,
and automations escalating on the third failure in a row. Parent conversations get one `pause.held` entry, never one
per child (`pause/README.md:17`). That is the right shape. Missing: nothing structural. The rule to state is the
_stopping_ rule (below), so that a nested failure of ten workers produces one card and no model churn.

### When stopping is right, rather than trying another model

Stop, and say so on one card, when:

1. the failure is not about the account being spent — a malformed request, an invalid tool schema, a 400 the model
   caused. Another model does not fix a broken prompt; it pays for a second attempt at it;
2. the only remaining candidate cannot hold the conversation (D);
3. the only remaining candidate is a billed login the conversation's family did not declare (E);
4. a subscription model failed for a reason that is not quota (F) — the subscription is the plan of record;
5. this conversation already took this step for this input (the `alreadyAsked` guard,
   `extensions/models/fallback.ts:149-164`, generalised to steps).

Continue on another model only when the provider is spent _and_ the next declared step can hold the conversation.

### The user's rule: a free model stays disabled until it is enabled again

Today's mark is a ten-minute cooldown per **provider** (`extensions/models/quota.ts:15`, `:18`, `:89-93`), read by
`spent()` (`:29`) and honoured by the chain (`fallback.ts:75`). Change it to a mark that does not expire on its own, for
**free** models only:

- **Shape.** `{ providers: { [provider]: { at, until? } }, models: { ["provider/id"]: { at } } }` — the same document,
  one new map. `until` stays for paid providers (a cooldown is right there: a paid quota usually resets, and the user
  wants paid work to resume).
- **Which one to set.** From a single refusal the client cannot tell a per-model limit from a per-key one, and a
  successful response advertises none (measured on a 200: no `x-ratelimit-*`, no `retry-after`). So the narrowest mark
  first: a refusal from `provider/model` disables **that model** only, and every other hub model stays usable — which
  is what the user asked for. If a _different_ model of the same provider refuses the same way within a short window,
  set the provider mark too. Two marks, one comparison, no probing.
- **Chain interaction.** `allowed()` already excludes a spent provider (`fallback.ts:65-66`); extend it to exclude a
  disabled model, and the landed fallback lists do the rest — the chain simply walks to the next entry
  (`lib/families.ts:189-196`, `fallback.ts:81-90`). A disabled free model must never be retried on the next input: it is
  already excluded at the _candidate_ stage, before any request.
- **Where the user enables it again.** One action, `models.enable { provider, modelId? }`, in the one place models are
  configured — the families panel behind ⌘K **Model families…** (`extensions/models/family-editor.tsx`), where each
  family's popover already lists model, thinking and fallback. Two doors to it: the popover's model line, and the card
  that told the user it was disabled.
- **What it looks like while it holds.**
  - status line model item: `⛔ GLM-5.3 · disabled` (amber), its popover naming the refusal, when, and **Enable again**;
  - family popover: `llmhub/GLM-5.3 · disabled 12 min ago · Enable`;
  - the card: header **`disabled · free model rate limited`**, body "llmhub/GLM-5.3 refused a request as rate limited at
    14:02 and stays off until you enable it", with **Enable again** and **Pick another**. This is deliberately _not_ the
    existing `needs you · out of quota` card (`extensions/models/web.tsx:179-242`): that one is about a paid login the
    run cannot proceed without, and merging them would blur exactly the distinction the user cares about. A missing
    login stays `needs you · login missing` with its **log in** link.
- **Not pausing.** With a disabled model, the pause that a free 429 causes today (B) should not happen: the run fails
  once, the mark is set, and the chain steps. Paid 429s keep pausing.

## 5. Paid spend

What exists:

- **Cost is recorded** per conversation and per model, in the commit that records the response
  (`.../harness/usage.js:3-39`), priced from the model's own metadata: `deepseek/deepseek-flash` is $0.30/M input,
  $1.20/M output, $0.006/M cache read; both hub models are $0.00 everywhere.
- **It is visible**: project totals in the status line (`extensions/status-line/web.tsx:214-218`), per message on hover
  (`:293-316`), and the Info panel (`extensions/info/web.tsx:313-314`).
- **This project's books** (one state home, 51 conversations): **$13.13**, 541.9 M tokens, entirely on paid DeepSeek.
  @ultimate alone is $4.04; the largest branches are $1.49 and $1.45. Free usage in the same period: 6.24 M GLM tokens
  and 3.6 M preview tokens, $0.
- **Nothing bounds it.** No ceiling, no per-tree budget, no confirmation for a paid step. The amplifiers are:
  `retry.maxRetries: 3` with a 2 s base delay (`~/.pi/agent/settings.json`) — a failed 400k-token request can cost four
  times its input; each Play while a rate limit holds spends one retry (`pause/README.md:18`); and `maxTokens: 384000`
  on Flash bills output at $1.20/M.
- **The silent path is the ordinary one**: a family's model is paid, so nothing "crosses" to paid — the conversation
  simply starts there.

The smallest enforceable rule set (no forecasting):

1. **Paid only as a declared step.** A conversation may reach a billed provider only if the path to it is written down:
   its family's model, or an entry in that family's fallback list. Concretely: remove the unconditional `default`
   candidate at `fallback.ts:86-87` (scenario E). This one change makes "all free are down" a stop instead of a bill.
2. **A ceiling per conversation tree**, a deliberately new settings key (no existing key means this), off by default:
   `{ "spend": { "perTreeUsd": 1 } }` — read from
   `pi.usage` over the conversation and its descendants, checked in the same commit-subscription pattern
   `extensions/models/quota.ts:63-87` already uses, writing one card at 80% and refusing the next _paid_ request at
   100% (a free step is still allowed). A tree, not a branch: a subagent is where a runaway loop hides, and its usage
   is already recorded on its own conversation.
3. **One card when a conversation first spends.** The first billed response of a conversation writes one quiet entry
   naming the family, the provider and its rate — the same shape as the fallback card, not a dialog. It makes the
   difference between "this branch runs on free tokens" and "this branch is billing" visible without opening a panel.
4. **Paid 429s keep pausing; free 429s never pause** (scenario B). This is what makes controls 1–3 livable: the user is
   not asked to spend, and not asked to press Play for someone else's free limit.

## 6. Roadmap

**P0 — a model switch may never silently condense a conversation.** _(the destructive-transition question)_
Prevents: findings 1, 3, 4 and 6 — the actual incident, and the wedge.
Size: ~100–150 lines. Where: `server/api.ts:674-712` (the `configure` route) and
`extensions/models/fallback.ts:81-90` (candidate selection), one new card beside `FellBack`
(`extensions/models/web.tsx:179-242`), one or two tests.
Reuses: `ContextUsageDoc` (`extensions/conversations/api.ts:99-107` — already the one measure of how full a
conversation is), the model list's `contextWindow` (`shared/protocol.ts:181`), the existing card vocabulary.
Behaviour: (a) the fallback chain **skips** any candidate whose window cannot hold the conversation's tokens; (b) a
manual switch to a smaller window asks first, on one card — "This conversation holds 389,570 tokens; GLM-5.3 is declared
at 128,000. Switching condenses it into a summary on the next turn." — with **Condense on the current model, then
switch**, **Switch anyway**, **Cancel**; (c) a manual `compact` command keeps its current meaning but says which model
writes the summary.
Risk: the context document is a cache and can be stale or estimated. Treat it conservatively — if `estimated`, say "at
least" and compare against the same figure; a stale figure only moves the warning, it cannot create the failure mode
this prevents. Second risk: a pin carried by a definition is applied at spawn (`lib/agents.ts:151`) and never confronts
a conversation's contents, so P0 must not try to guard spawn; only changes to an _existing_ conversation need it.

**P1 — a free model that refuses stays off until the user turns it back on.**
Prevents: the pause storms (finding 7) and retrying into a wall.
Size: ~120 lines in `extensions/models/quota.ts` (mark shape, free-vs-paid), `extensions/models/fallback.ts:65-66`
(skip disabled models), `extensions/models/server.ts` (one `enable` action), the families panel and the card, one pause
hook in `extensions/pause` (do not hold for a free provider), `~/.pi/agent/settings.json` untouched.
Reuses: the mark document and its commit watcher, `outOfQuota`, the fallback lists landed in `#19703`, the family
popover, the `needs you` card.
Risk: too narrow a mark under-protects (a per-key limit disabled only per model costs one more refusal per model —
cheap, and self-correcting); too wide a mark (provider-wide on first refusal) strands the fifteen other hub models, so
narrow first is the right default. Second risk: the user forgets, and a family silently sits on its paid fallback —
mitigated by the status-line mark and the card, both of which name the disabled model.

**P2 — a paid step must be declared, and a tree has a ceiling.**
Prevents: the €20 class of surprise.
Size: ~80 lines (drop the default candidate; read `pi.usage` costs on commit; one card; one settings key), plus a test.
Reuses: `pi.usage`, the quota watcher's subscription pattern, the fallback card.
Risk: removing the unconditional default step changes existing behaviour for anyone relying on it — it is a
one-release surprise, and the honest fix is a card that says "nothing left to move to; log in to X or pick a model".

**P3 — measures to fit the role, not the accident.** Two small things: (a) a worker/designer conversation that crosses a
threshold writes one divider suggesting a handoff ("this task is finished; start the next one in a new session"),
rather than silently growing to 240k; (b) `deepseek/deepseek-flash` gets the compaction override its 1M window deserves
(section 7). Size: (a) ~40 lines in `extensions/conversations` reusing `ContextUsageDoc` and the existing divider
renderer; (b) one settings entry. Risk: a suggestion is easy to ignore; keep it a suggestion.

**Flagged as unnecessary complexity, not built:**

- A general router that scores models by cost, latency and task type. Three families were re-specified in one day;
  a scoring model would have been wrong three times and would have hidden the change. A guard and a mark do not need to
  know what the map is.
- Forecasting or budget projection ("you will spend €X this month"). The recorded number is already exact; a forecast
  adds a model of the user's behaviour on top of a measured one.
- Binary-searching the hub's real window. See section 8: one GET, one 1-token completion and one observed error text
  answer it for free, and the number is not the mechanism anyway.
- A per-role UI for model assignment. The families panel already does this (`extensions/models/family-editor.tsx`).
- Automatic A/B or quality scoring of free vs paid output. There is no ground truth to score against, and the user's
  framing is successful work per euro, which is measured by outcomes (landings), not by ratings.

## 7. Configuration

Real keys only; nothing invented. Ordered by what I would change first.

1. **Take the 128k fallback off every long-lived family** (`.ultimate/settings.json`, and the same lines in
   `~/.ultimate/model-families.json` — `recent` and any per-project entry, which currently carry the same
   values). Today:

   ```json
   "default": { "model": "deepseek/deepseek-flash", "fallback": "llmhub/GLM-5.3" },
   "lead":    { "model": "deepseek/deepseek-flash", "thinking": "high", "color": "orange", "fallback": "llmhub/GLM-5.3" },
   "fast":    { "model": "deepseek/deepseek-flash", "fallback": "llmhub/GLM-5.3" },
   "design":  { "model": "deepseek/deepseek-flash", "thinking": "high", "fallback": "llmhub/GLM-5.3" }
   ```

   Change each `fallback` to `"openai-codex/gpt-6-luna"` (272,000, a subscription) — or delete the key so a spent
   DeepSeek gives the needs-you card instead of a silent condense. Delete is the honest choice while Codex is failing
   on this machine; the key cannot be an empty list (`lib/families.ts:88-110` refuses one), so "none" means omitting it.

2. **Give the small tier a free-first chain, paid last** (`tiny`), and only there:

   ```json
   "tiny": { "model": "llmhub/GLM-5.3", "thinking": "low",
             "fallback": ["llmhub/DeepSeek-V4.1-Flash-Preview", "deepseek/deepseek-flash"] }
   ```

   The landed list feature walks these one step per failure (`lib/families.ts:189-196`). With P1, a disabled GLM-5.3 is
   skipped rather than retried.

3. **The 1M model keeps only 20k of recent context today.** Pi's defaults suit a ~200k window
   (`docs/settings.md:38-45`); `server/harness.ts:69-84` overrides them for Codex Sol and the Claude models but not for
   `deepseek/deepseek-flash`. Either add it to `compactionOverrides` (`server/harness.ts:69-84`, a code change) or, as
   settings today, in `~/.pi/agent/settings.json`:

   ```json
   "compaction": { "modelOverrides": {
     "deepseek/deepseek-flash": { "reserveTokens": 32768, "keepRecentTokens": 60000, "backgroundTokens": 131072 }
   } }
   ```

   This does not prevent a bad switch; it stops the _good_ model from keeping only 20k of recent context when it
   condenses at 984k.

4. **`summaryModel`** — decide, do not leave it implicit. It is pinned to paid Flash today and a pinned summary model
   never falls back (`extensions/conversations/summary-model.ts:104-110`). Moving it to `"llmhub/GLM-5.3:low"` makes the
   volume free; leaving it keeps abstracts sharper. It is not where the €20 went (see section 5), so I would leave it
   and revisit after P2 gives per-tree numbers.

5. **`instance.model`** (unset) — previews currently inherit the previews family (`fast` = paid Flash). Setting it to
   `"llmhub/GLM-5.3"` moves every preview, and every agent inside one, onto free tokens; `null` turns the override off.
   Safe as a decision, once P0 exists so a preview cannot condense a long conversation either.

6. **`fastModels`** — leave empty. It only affects `openai/` and `openai-codex/` models and raises the usage rate
   (`extensions/fast/README.md:1-16`); nothing in this map benefits.

## 8. Open questions

1. **What the hub models' real limits are.** `GET /v2/models` returns 16 models with `id`, `object`, `created`,
   `owned_by` and nothing else — no context length, no token limits, no rate-limit fields. `~/.pi/agent/models.json`
   declares none either, so `128000 / 16384` are Pi's schema defaults (`pi-coding-agent/dist/core/model-config.js:44-45`).
   The user's dashboard figure (~1M for `DeepSeek-V4.1-Flash-Preview`) is therefore neither confirmed nor contradicted
   by anything the client can see. **Unknown**, and the only cheap way to learn it is to capture the _next_ real
   context-overflow error from the hub once, which normally names the maximum.
2. **Whether the refusals are per model or per key.** A 1-token `GLM-5.3` completion returned 200 while the pauses were
   happening, and no response carried a rate-limit header, so the limit is only visible at refusal. The cheap
   discriminator when it next happens: send one 1-token completion to `llmhub/DeepSeek-V4.1-Flash-Preview`. If it
   answers while `GLM-5.3` is refused, the limit is per model; if both refuse, per key. My P1 design assumes per model
   first and falls back to provider-wide on a second, different-model refusal.
3. **Whether `GLM-5.3` is rate-limited or misconfigured.** Not misconfigured: it answers 200 in 0.4 s, and the refusals
   coincide exactly with several agents calling it at once (four pauses in an hour with two scouts running; none before
   or after). Its response also carries `reasoning_content` although the registration says `reasoning: false`, so its
   thinking cannot be turned down and Pi does not count it. Whether that contributes to the load I cannot tell.
4. **What the €20 actually was.** This project's own books record $13.13 (≈€12) on paid DeepSeek across 51
   conversations, all of it `deepseek/deepseek-flash`. For scale: one turn of @ultimate, at 389,570 tokens, costs about
   $0.12 of input alone, so €20 is a few hundred large turns rather than an anomaly of rates. The gap between €12 and
   €20 could be another project's state home (this figure covers one home only), usage before cost recording, or the
   provider's dashboard counting differently. I cannot see billing, so I state the recorded figure and not a cause.
5. **Whether a paid DeepSeek login is prepaid or invoiced.** `lib/rate-limit.ts:19` treats an "Insufficient Balance"
   refusal as spent, which suggests a prepaid balance is possible here; if it is prepaid, a balance threshold would be
   the cheapest ceiling of all, and I cannot read it from the machine.
6. **How often free 429s happen in normal use.** Four in an hour here is _this_ hour, with unusual concurrency
   (two subagents plus a paid run). The 7-day figure in #19213 is four, which is what a quiet week looks like. Neither
   tells us the rate at which a routine setup would trip the user's new rule — that needs a week of marks, not a probe.

### Rejected: declaring an optimistic `contextWindow` in `~/.pi/agent/models.json`

The proposal was to raise a hub model's declared window so Ultimate stops treating it as small. It is rejected, for
two reasons that point in opposite directions. A declared window is not a capability: it is the number Pi compares the
context against (`generation.js:237-241`), so raising it moves _when compaction stops_, not what the provider accepts.
Declared too high, the requests that used to be condensed now go out whole: the provider refuses them at its real limit,
Pi spends its three retries on identical oversized requests (`retry.maxRetries: 3`, `~/.pi/agent/settings.json`), each
paid attempt billing its full input at $0.30/M — the exact loop that produced the bill this audit is about — and only
then does the overflow path compact (`generation.js:406-424`), on a model that has just refused, where it can fail as
well. Declared too low, the only cost is the condensation we are trying to avoid, and no data is lost. So a wrong-high
declaration turns a loss of working state into a loss of money, and a wrong-low declaration only into the loss we already
have. The measured number, not a hopeful one, is what should go in that file — and it is obtainable for free: capture
the text of the next real context-overflow refusal from the hub (those messages normally state the maximum), or, if
nothing refuses, double a prompt of repeated text against one free model until it does. Both are bounded requests on a
model that costs nothing; neither guesses.
