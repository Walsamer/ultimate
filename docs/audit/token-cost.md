# Where the tokens go

A read-only audit of agent spend on this machine: three Ultimate projects, 255 conversations,
**$92.60** of paid inference. Every number below comes from stored `pi.usage` documents, the trace
database (`kind: 'model'` rows carry `input` / `cacheRead` / `output` per request), and stored
conversation entries. Nothing was re-run; no request was made to a provider for this audit.

**The one sentence:** cost is not the work. It is the _transcript being re-submitted_ — 3,120M prompt
tokens to produce 14.5M output tokens (215 : 1), of which the expensive part is not the token count
but how often the same tokens are billed at full input price after the prompt prefix changes.

Notation used throughout: **input** = uncached prompt tokens (billed at the input price), **cacheRead**
= re-read prompt tokens billed at the provider's cache price, **output** = generated tokens,
**context** = input + cacheRead for one request. Prices are the ones recorded in the usage documents:
`deepseek/deepseek-flash` $0.30 / $0.006 / $1.20, `openai-codex/gpt-6-astra` $10 / $1 / $50 per million
for input / cacheRead / output.

---

## 1. Coverage and how to read the numbers

| Source                                                  | Use                                                                                          | Caveat                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pi.usage` per conversation                             | authoritative spend, per model, split into input / cacheRead / output                        | one document per conversation; the sum over a project matches the totals in the brief                                   |
| trace, `kind: 'model'`                                  | per-request input / cacheRead / output                                                       | the store keeps roughly the newest 1,000 rows per conversation, so request-level detail exists only for recent activity |
| entries (`pi.system`, `pi.assistant`, `pi.tool-result`) | request counts (one assistant entry per request), context composition, system-prompt patches | older conversations may be trimmed by retention                                                                         |

Coverage: the three projects that were running (their conversations only, all 255 of them, including
subagent conversations such as reviewers, workers, scouts and dream passes, which do **not** appear in
the project's own conversation list but do carry their own usage).

review #24569 is a `reviewer` conversation; its cost sits in its own conversation, not in the
branch that started it. This is why per-branch accounting understates review cost by ~16%.

---

## 2. The money, by bucket, by role, by model

Across all 255 conversations:

| bucket         | spend      | share   | tokens |
| -------------- | ---------- | ------- | ------ |
| uncached input | **$49.99** | **54%** | 143M   |
| cache read     | $23.51     | 25%     | 2,911M |
| output         | $19.10     | 21%     | 14.5M  |

By role (label of the conversation; suffix stripped):

| role                             | convs | spend  | share | uncached | cacheRead | output |
| -------------------------------- | ----- | ------ | ----- | -------- | --------- | ------ |
| coordinator (branch)             | 111   | $54.37 | 59%   | $31.92   | $11.95    | $10.50 |
| reviewer                         | 46    | $14.78 | 16%   | $6.34    | $4.85     | $3.60  |
| @ultimate (standing)             | 3     | $11.94 | 13%   | $7.27    | $3.25     | $1.42  |
| dream-pass                       | 36    | $5.42  | 6%    | $2.93    | $1.35     | $1.14  |
| worker                           | 23    | $4.05  | 4%    | $0.90    | $1.46     | $1.69  |
| designer                         | 2     | $1.08  | 1%    | $0.12    | $0.59     | $0.37  |
| scout                            | 22    | $0.33  | <1%   | $0.14    | $0.06     | $0.13  |
| watcher, lander, side-chat, root | 8     | $0.07  | <1%   |          |           |        |

By model: `deepseek/deepseek-flash` $76.28 (82%), `openai-codex/gpt-6-astra` $10.24 (11%),
`openai-codex/gpt-6.1-sol` $5.53 (6%), `deepseek/deepseek-v4-pro` $0.56, free hub models $0.00.

Concentration: 13 conversations (5% of 255) account for **$30.89 (33%)**. In those 13: 4,310 requests,
**259k average context per request**, $0.0072 per request, 389 prompt tokens per output token.

Cost per unit at the current rate: $0.32 per reviewer conversation (46 of them; the most expensive one
produced 4 verdicts for $4.36), $0.49 per coordinator conversation, $0.15 per dream pass, $0.0072 per
model hop.

---

## 3. The mechanism: every prompt-prefix change re-bills the whole context

Request-level traces show one dominant pattern. Uncached input is not the size of the new material; it
is (**number of system-prompt section patches**) × (**context size**).

Test on 13 conversations where both numbers are measurable (patches counted from `pi.system` entries,
context from usage; entry counts are paged and can be off by one or two, which is inside the model's
noise):

| conversation                   | patches | avg context | predicted | measured uncached | ratio    |
| ------------------------------ | ------- | ----------- | --------- | ----------------- | -------- |
| standing agent A #42 (@ultimate) | 33      | 280k        | 9.24M     | 9.31M             | 0.99     |
| standing agent B #40 (@ultimate)       | 33      | 319k        | 10.52M    | 11.25M            | 0.93     |
| branch #48346 (branch) | 41      | 186k        | 7.61M     | 8.64M             | 0.88     |
| project A #993            | 37      | 248k        | 9.17M     | 4.98M             | 1.84     |
| project A #47834          | 45      | 206k        | 9.25M     | 6.05M             | 1.53     |
| project A #45690          | 33      | 140k        | 4.63M     | 5.05M             | 0.92     |
| project A #32704          | 23      | 210k        | 4.83M     | 3.44M             | 1.41     |
| ultimate #13069                | 27      | 180k        | 4.87M     | 3.59M             | 1.36     |
| … 5 more                       |         |             |           |                   |          |
| **sum (13 conversations)**     | 358     |             | **76.2M** | **72.7M**         | **1.05** |

A patch predicts the re-bill within 5% in aggregate (over-prediction where context was still small, as
expected). Distinct content in those same 13 conversations — everything ever read and written, counted
once — is ≈16.0M tokens. So **72.7M uncached tokens were billed for 16.0M tokens of material: 4.5x
over-billing** (1.9x to 24x per conversation; one outlier at 162x whose usage does not reconcile, see
§8).

Extrapolated over all 255 conversations: roughly **$33 of the $49.99 uncached bill (~36% of total
spend) is material paid for more than once at the full input price.** Confidence: high on the
mechanism, medium on the extrapolation (13 of 255 conversations, 4,310 requests).

### 3.1 What causes a patch

Section patches counted from `pi.system` entries, by the keys each patch entry carries (two
conversations). An entry carrying more than five keys is a full baseline; a reorder is written as an
all-null entry followed by an all-values one, so it lands in that row:

| changed section                                                                           | standing agent A | standing agent B |
| ----------------------------------------------------------------------------------------- | ------------------------ | ------------------ |
| full baseline (all sections re-added)                                                     | 4                        | 5                  |
| `background` (background jobs)                                                            | 9                        | 2                  |
| `subagents` (agent definitions)                                                           | 6                        | 11                 |
| `project_context` (AGENTS.md)                                                             | 4                        | 1                  |
| `automations`                                                                             | 4                        | 2                  |
| `skills`, `building_blocks`, `environment`, `test_core_changes`, `codemode`, `principles` | 8                        | 16                 |
| `messages` (pending questions)                                                            | –                        | 3                  |
| `projects`                                                                                | 1                        | 3                  |

Two families:

1. **Live state that ticks.** `extensions/jobs/server.ts:52` renders a job line with elapsed time
   computed from `Date.now()`, registered as the `background` section at `:377`. While a job runs, its
   text differs on every request.
2. **Values that legitimately change** (agent definitions, AGENTS.md, skills, plan ledger, workspace
   tips, memory tally, chat questions) plus **reorders**: a section that appears or disappears changes
   the section _order_, and `planSections` (`@earendil-works/pi-durable/dist/harness/prompt.js:100`)
   then removes every section and re-adds every section — a full baseline rewrite, observed as a pair
   of `pi.system` entries, e.g. all-null followed by all-values.

The prompt builder already knows this costs money — the jobs and automations sections carry the
comment _"Always rendered: a section that disappears and reappears reorders the prompt, which rebuilds
it whole"_ (`extensions/jobs/server.ts:380`, `extensions/automations/server.ts:853`). `subagent_state`
(`extensions/subagents/server.ts:828`) returns `undefined` when idle, so it does exactly what those
comments warn about, twice per subagent.

---

## 4. Case study 1 — a review: review #24569, $4.36

The third most expensive single conversation on the machine, and the most expensive _review_.

|                      |                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| role                 | `reviewer` conversation (one reviewer, told to review one feature branch)                                                     |
| model                | `openai-codex/gpt-6-astra` (input $10/M, cacheRead $1/M, output $50/M)                                                        |
| requests             | 32 model requests over 20 minutes, 6 instructions from the coordinator, 4 verdicts                                            |
| context              | 6,680 tokens at the first request → 119,577 at the last, average 86k                                                          |
| fresh or accumulated | **fresh start, accumulated across rounds**: request 1 is the system prompt alone; the four review rounds share one transcript |
| tokens               | input 108k, cacheRead 2.48M, output 15.7k                                                                                     |
| cost                 | cacheRead **$2.48 (57%)**, input $1.09 (25%), output $0.79 (18%)                                                              |

Per round (measured from the request series):

| round | requests | context      | cost        |
| ----- | -------- | ------------ | ----------- |
| 1     | 19       | 6.7k → 88.4k | $2.37 (55%) |
| 2     | 7        | 91k → 113k   | $1.12       |
| 3     | 3        | 114k → 118k  | $0.46       |
| 4     | 3        | 118k → 120k  | $0.39       |

Composition of what it carried (687k characters stored): tool results 433k (63% — diffs and test
output), assistant messages 216k (31%), system prompt and instructions 36k (5%). The system prompt is
24,907 characters ≈ 6.2k tokens, which is exactly the first request.

**Why it cost as much as a whole feature elsewhere:** reading the range once is not the expense; the
expense is that this reviewer conversation then re-read its own 90–120k transcript on 30 further hops,
at a cache price 167x DeepSeek's. Rounds 2–4 (12 requests) produced 6.4k output tokens and cost $1.97.
A fresh reviewer per round would have re-read the whole range each time — measured against round 1's
$2.37 that is **not** a saving, which is why §7 refuses that proposal.

---

## 5. Case study 2 — a branch: branch #48346, $2.88

|          |                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| role     | coordinator branch (feature work, landing a revert plus a verdict log)                                                               |
| requests | 184 (`pi.assistant` entries)                                                                                                         |
| context  | average 186k; the traced 20-minute window runs 194k → 278k                                                                           |
| cost     | uncached input **$2.59 (90%)**, cacheRead $0.15, output $0.13                                                                        |
| shape    | 41 `pi.system` entries (3 full baselines, 38 patches), 583 entries, 7.4M characters of stored history of which 6.6M are tool results |

Inside the traced window, 89 requests: **39 of them were billed the entire context as uncached input**
(8.45M tokens), 50 were cached (~1.4k new tokens each). 8.45M of this conversation's 8.64M total
uncached tokens came from those 39 requests: 98% of its uncached bill in 7 minutes.

The 39 requests correlate exactly with a background job running, and the cache collapse is visible in
the token arithmetic:

```
15:33:26  in=204,316  cr=4,352   context 208,668   ← job running: whole prompt re-billed
15:34:34  in=847      cr=213,376 context 214,223   ← job ended ("None running"): cached
15:35:28  in=224,196  cr=4,352   context 228,548   ← next job: re-billed again, and so on
15:38:01  in=22,432   cr=223,744                  ← the one request the job had stopped before
15:46:03  in=210      cr=262,656                  ← cached again
```

4,352 cached ≈ the 19,103 characters (~4.4k tokens) that the sections listed _before_ `background` in
the recorded section order contain — a consistency check, not an independent measurement. The
divergence point is the `background` section: everything after it is paid at input price. `background`
is 44 characters when idle and ~480 when a job runs, of which the changing part is the elapsed seconds
rendered by `extensions/jobs/server.ts:52`.

Causal claim I can defend: 30 requests while `running · Ns` was in the prompt were all full misses; the
requests before and after, when it said `None running`, were cached; no other section in those requests
changed. The provider rule that turns a mid-prompt change into a whole-context miss is **inference** —
the code path (`@earendil-works/pi-ai/dist/utils/text.js:11`, `dist/api/openai-completions.js:928`)
renders the leading system message as the complete prompt, which is consistent with it.

---

## 6. Case study 3 — standing agents: standing agent B #40, $4.71 and standing agent A #42, $4.84

|                       | standing agent B #40         | standing agent A #42   |
| --------------------- | -------------------- | -------------------- |
| role                  | @ultimate (standing) | @ultimate (standing) |
| requests              | 596                  | 1,011                |
| avg context           | 319k                 | 280k                 |
| prompt tokens         | 190M                 | 283M                 |
| output tokens         | 353k                 | 632k                 |
| prompt : output       | 538 : 1              | 448 : 1              |
| uncached input        | $3.21 (68%)          | $2.54 (52%)          |
| cache read            | $1.07 (23%)          | $1.62 (34%)          |
| output                | $0.42 (9%)           | $0.68 (14%)          |
| system-prompt entries | 33                   | 31–33                |
| distinct content      | 859k tokens          | 1,716k tokens        |
| over-billing          | 13x                  | 5.4x                 |

Shape: a standing agent lives for days, wakes on notes, landings, board replies and subagent results,
and every wake re-sends everything it has ever read. Two separate bills come out of that:

- **The continuation bill** (cacheRead): 190M–283M prompt tokens at $0.006/M. Cheap per token, but it
  grows linearly with hops × context, and it is the single largest _token count_ on the machine.
- **The re-bill bill** (uncached): 33 patches × ~280–320k ≈ 10.5M tokens each at $0.30/M. About
  two-thirds of that is material the agent had already read (see §3).

Both scale with the same variable, and that variable is unbounded: see §7.

---

## 7. Context audit, with citations

**Do workers inherit parent history? No.** A subagent definition starts a _fresh_ conversation
(`extensions/subagents/server.ts:974–981`: history is forked only when `args.fork` is set, and the tool
description warns it costs more context). The child receives its agent definition, its own system
prompt, and the task text; the parent receives the final answer and a renderer card, never the child's
transcript. Good design, and it is why reviewers cost $0.32 per run rather than accumulating.

**Do reviewers run fresh? Yes, and that is the correct shape.** 46 reviewer conversations, 112M prompt
tokens, 1.56M output. The expensive one (#24569) is expensive because it ran four rounds in one
conversation, not because it started fresh.

**Are large tool outputs left in context? Yes, and they dominate the transcript:** 6.6M of #48346's
7.4M stored characters are tool results; 18.1M characters in #21683. Tools bound a _single_ result's
size (`outputLimits { maxBytes, maxLines, retain }`, `@earendil-works/pi-durable/dist/harness/types.d.ts:269`;
bash keeps the tail, `dist/tools/bash.js:106,128`), but nothing bounds the _accumulation_: history is
sent whole until a compaction runs.

**Does compaction ever run? No — not for the model everything uses.** Defaults are reserve 16,384,
keep recent 20,000, background 32,768 (`dist/harness/agent.js:12–16`); the threshold is
`contextWindow − reserveTokens` (`dist/harness/generation.js:237–247`). This repository overrides that
policy per model in `server/harness.ts:73–92` — for the Codex and Claude models, with the comment
_"1M windows, 128k answers: blocking at ~967k"_ — but **there is no `deepseek/deepseek-flash` entry**.
That model's window is 1,000,000 tokens, so blocking compaction would start at 983,616 tokens. Observed
peak context: 386k (branch #20877), 462k (project B #12400). Compaction never fired in any of
the 255 conversations — no `pi.compaction` entry exists in any of the ones examined.

**How big is the system prompt?** Measured by serialising the sections of a coordinator branch:
44,479 characters ≈ 11.1k tokens.

| section                        | chars  |     | section                      | chars |
| ------------------------------ | ------ | --- | ---------------------------- | ----- |
| instructions (AGENTS.md)       | 15,560 |     | messages                     | 913   |
| lineage (memory brief + tally) | 5,307  |     | workspace_workflow           | 722   |
| skills                         | 4,823  |     | codemode                     | 685   |
| project_context                | 4,088  |     | visual_verification          | 519   |
| principles                     | 2,098  |     | environment                  | 515   |
| tools                          | 1,716  |     | conversations                | 472   |
| self_awareness                 | 1,665  |     | identity                     | 460   |
| self                           | 1,658  |     | test_core_changes            | 391   |
| subagents                      | 1,194  |     | secrets                      | 228   |
| building_blocks                | 1,151  |     | automations, cwd, background | 314   |

That is 4% of a 260k context — the system prompt is **not** a driver of cost at current context sizes,
though it is 100% of a conversation's first request. Shortening it is not a lever (§10).

**Do patches really re-bill?** Mechanically: sections render before every request and differences are
recorded as `pi.system` patches (`dist/harness/prompt.js:56`, `:100`); the leading system message is
rendered as the whole prompt (`@earendil-works/pi-ai/dist/utils/text.js:11`), and the harness moves
only the first system message to the front so a later tool change cannot invalidate everything
(`dist/harness/context.js:141–148` — the comment names the exact hazard this audit measured). The
measured cost of a patch is the whole context, so in practice the leading prompt is rebuilt.

---

## 8. Something I could not reconcile

`project B` #42 reports 5.4M uncached + 92.3M cacheRead across 56 assistant entries — an implied
average of 1.75M tokens per request, above the model's 1M window. Either its entries were trimmed by
retention or its usage document accumulated across resets. It is excluded from the patch model of §3
(it has zero `pi.system` entries, which is itself suspicious) and its $2.40 is carried in the totals.

---

## 9. Ranked drivers

| #   | driver                                                                                                        | spend                                                                               | confidence                             | evidence                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | **Prefix churn re-billing context**: every section patch re-bills the whole context at input price            | ~$33 (36%)                                                                          | high on mechanism, medium on total     | patches × context predicts uncached input within 5% over 13 conversations; 4.5x over-billing vs distinct content |
| 1a  | ↳ of which: `background` ticking timer                                                                        | $2.54 in the one conversation that could be aligned; 5–15% of total (**inference**) | high (measured causation, 30 requests) | `extensions/jobs/server.ts:52`; perfect correlation in §5                                                        |
| 1b  | ↳ live sections appearing/disappearing → full baseline rewrite                                                | part of #1; 9 of 31 patches in one conversation                                     | high                                   | `extensions/subagents/server.ts:828`; the all-null + all-values pair at 15:40:26                                 |
| 1c  | ↳ legitimate changes (agent defs, AGENTS.md, skills, plan ledger, tally)                                      | part of #1                                                                          | high                                   | §3.1 table; the dogfooding tax of developing Ultimate with Ultimate                                              |
| 2   | **Unbounded working set**: no compaction for the 1M-window model everything runs on                           | $23.51 cacheRead (25%) + it multiplies #1                                           | high                                   | `server/harness.ts:73` has no deepseek entry; peak context 386–462k; zero compactions                            |
| 3   | **Output** — the work itself                                                                                  | $19.10 (21%)                                                                        | high                                   | 14.5M output tokens; not waste, but the base rate of doing the work                                              |
| 4   | **Review price**: reviewers run on Codex at 33x the input price and 167x the cache price of the default model | $14.78 (16%)                                                                        | high                                   | per-model table §2; 112M prompt tokens for $14.78                                                                |
| 5   | **Hops**: 259k average context × 4,310 hops in 13 conversations                                               | subsumed by #1 and #2                                                               | medium                                 | $0.0072 per hop; 389 prompt tokens per output token                                                              |
| 6   | **Dream passes**: 36 automatic memory passes on a paid model                                                  | $5.42 (6%)                                                                          | medium                                 | 49M prompt, 0.96M output                                                                                         |
| 7   | Fallback re-submission (Codex refusal → DeepSeek re-sends the whole context)                                  | not measured, no failures in the traced windows                                     | low                                    | design-level risk in the model-family chain                                                                      |

What is **not** a driver, despite looking like one: the system prompt (4% of context), workers and
scouts (4% and <1%), tool output truncation (each result is bounded; the accumulation is the issue),
retries (none visible), and subagent context inheritance (none exists).

---

## 10. Proposals, cheapest first

Each: expected saving, the assumption behind the number, effort, risk to quality, how to verify.

### P1 — Take the ticking clock out of the prompt (a few lines)

`extensions/jobs/server.ts:52–63` renders `running · 19s` from `Date.now()`. Render the start time
instead (`started 15:33`), or keep elapsed time only on the job card, which the UI already shows.

- **Saving:** measured $2.54 → $0.05 for one 7-minute window in #48346 (50x on that slice). If jobs run
  during a similar share of hops elsewhere, 5–15% of total spend (**$5–14**). Assumption: the ticking
  value is what invalidates the cache (measured, not proven at the provider level).
- **Effort:** minutes. **Risk:** none to quality; the elapsed timer is available in the card and with
  `background list`.
- **Verify:** unit test — render all sections twice with a running job and a second of elapsed time
  between renders, assert the serialised section map is byte-identical. Then read the uncached share of
  conversations that start jobs before and after.

### P2 — Never let a section appear or disappear mid-conversation (one file + a rule)

`subagent_state` returns `undefined` when nothing runs; a section that vanishes reorders the prompt and
`planSections` (`prompt.js:100`) then rewrites all sections. Render it always with `None running.` — the
pattern `background` and `automations` already use — and make the section order independent of state.

- **Saving:** each event is one full-context re-bill; with a review team of three, ~6 events per review
  at 100–300k context ≈ $0.1–0.5 per review. Across 46 reviewer runs and the branches that wait for
  them: **$3–8** (inference).
- **Effort:** small. **Risk:** none.
- **Verify:** unit test that the section key list is identical across idle, one-child and two-child
  states; assert no all-null patch is ever planned.

### P3 — Bound the working set (the largest single saving)

Give the 1M-window family a working-set budget. Two forms:

- (a) a `compaction.modelOverrides` entry for `deepseek/deepseek-flash` in `server/harness.ts:73`, the
  same way the Codex and Claude models are handled — but the _inverse_ of what a 1M window suggests:
  `reserveTokens: 920000` yields blocking at ~80k;
- (b) better, a named setting (`compaction.workingSetTokens`) that pi-durable's compaction policy
  understands, so the threshold expresses intent rather than arithmetic on the window.

- **Saving:** both bills scale with average context. 259k → 80k cuts cacheRead ~3x ($23.51 → ~$7) and
  the re-bills in P1/P2 by the same factor ($33 → ~$10). **Estimated $28–38 of $92.60 (30–41%)**.
  Assumption: average context falls proportionally for long conversations; short ones are unaffected;
  each compaction costs ~$0.09 (one summary request at 300k input).
- **Effort:** settings change, or ~20 lines in the compaction policy. **Risk:** real — a summary loses
  detail. Mitigation: keep the recent window large (20k → 40k), never compact while a submit, a review
  round or a landing is in flight, keep decisions in memory and the plan ledger where retrieval can
  reach them, and accept a slow first hop after each compaction.
- **Verify:** §11's scripted review and scripted branch at three budgets, with seeded-defect recall as
  the quality gate; then compare cost per validated task on two real tasks.

### P4 — Fewer patches: coalesce and drop cosmetic changes

One patch per run at most; never patch for values that carry no information (counters, timestamps,
ids, "None running" → "None running"). The ultimate project patches `project_context`, `skills`,
`building_blocks` and `test_core_changes` because its own prompt files change while it works — those
patches are legitimate, but they can be _deferred to the next run boundary_ instead of mid-turn.

- **Saving:** 358 patches over 13 conversations ≈ one per 12 hops; if a third are avoidable, **5–10%
  ($5–9)** (inference).
- **Effort:** small-to-medium, mostly in the section renderers. **Risk:** low; deferring a prompt edit
  to the next turn cannot change the answer in flight.
- **Verify:** count patches per conversation before/after from `pi.system` entries; assert the answer
  quality on the scripted review is unchanged.

### P5 — Cap what a review round may read (review scope, not model)

Reviewers are 16% of spend at 33x the input price. Do **not** change the model. Instead: hand a
reviewer one range and a hard scope (files changed, not the repository), and have the coordinator pass
forward a compact findings handoff between rounds rather than continuing the same reviewer transcript.

- **Saving:** caps the tail risk; #24569 is 29% of all reviewer spend. Expected **$3–6** (inference).
- **Effort:** prompt/agent-definition guidance, no code. **Risk:** a too-narrow scope misses
  cross-cutting issues — keep the "read the whole range once" rule explicit.
- **Verify:** seeded-defect recall on the fixture range at each scope; cost per accepted verdict.

### P6 — Run dream passes on a free or cheap model

36 passes, $5.42 (6%), 49M prompt, 0.96M output, on the paid default model. A read-only pass that
writes a findings report is the ideal candidate for the hub chain the `tiny` family already uses.

- **Saving:** up to **$5 (5%)**. **Effort:** a model family assignment. **Risk:** dream quality — the
  pass must still find real problems; measure findings accepted per run, not tokens.
- **Note:** the free hub chain hit its quota during this audit (HTTP 429 from the `scout` model), so a
  free-only assignment trades cost for availability. A fallback to the paid model on refusal is fine.

### P7 — Make a fallback cheaper than a re-submission (design, not now)

The review family falls back from Codex to DeepSeek on refusal, which re-sends the whole context to a
second model. No fallback fired in any traced window, so there is nothing to measure yet. If it starts
mattering, the fix is a compacted request (range + findings, not transcript) for the fallback attempt.

- **Saving:** unknown, currently ~0. **Effort:** medium. **Risk:** a second model without the first's
  context reviews worse. **Mark unnecessary complexity until a fallback actually shows up in usage.**

---

## 11. Quality preservation — what each proposal must not break

| Must not break                                                 | Proposal it constrains | Guard                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture awareness (AGENTS.md, extension contracts, seams) | P3, P4                 | never compact the `instructions`/`project_context` sections; they are re-rendered from files every run, so a summary cannot lose them                           |
| Review independence                                            | P5                     | one reviewer per range, fresh context, no parent history; the handoff between rounds states findings, not conclusions                                           |
| Decision records                                               | P3                     | decisions live in memory and the plan ledger, which are re-rendered per run and retrievable with `memory`/`plan show`; a compacted transcript is not the record |
| Test coverage and verification                                 | P3, P4                 | checks and test runs are tool results the model can re-read on demand; a compacted transcript must not be the only copy of a failing test's output              |
| Continuity of a standing agent                                 | P3                     | the brief (lineage) and the memory index are re-injected each run; the transcript is not the continuity mechanism                                               |
| Escalation to the user                                         | all                    | no proposal may make an agent stop asking; a budget must never silently truncate a question                                                                     |

A saving that costs correctness is not a saving. Two proposals cross that line and are refused in §12.

---

## 12. What I would not change, and one proposal I refuse

**Refused — moving the review team onto the cheap model.** It would delete ~$14 of $92.60 (15%) at a
47x price difference and destroy the only independent correctness gate in the workflow. Review
independence is worth more than 15% of spend. The same argument rules out "cheaper review model with
more reviewers".

**Refused — hard per-task token budgets that abort a run.** Complexity that fails exactly when quality
matters: the expensive task is the hard task, and an agent that dies mid-verification costs more in
re-work than it saves. If budgets appear at all, they should warn, not kill.

**Refused as measured-not-worth-it — a fresh reviewer per review round.** It sounds like the tidy fix
for #24569, but round 1 (reading the range) cost $2.37 of its $4.36; rounds 2–4 together cost $1.97.
Re-reading the range four times would have cost more. Continuation was the cheaper choice.

**Would not change:**

- the system prompt's size or shape — 11.1k tokens is 4% of a 260k context; trimming skills or the
  memory brief buys pennies and costs the agent its bearings;
- fresh subagent contexts — the current design (no inherited history) is why a reviewer costs $0.32;
- the compaction machinery itself — it exists, is model-aware and is well designed; the gap is that it
  was never configured for the model everything now runs on;
- tool output truncation — bounding a single result is not the problem; accumulation is;
- the review model, the plan ledger, the lineage brief, or the escalation paths.

---

## 13. Benchmark plan

The metric is **cost per completed-and-validated task**, never tokens. A task counts only when its
acceptance criteria pass (checks green for a branch; seeded defects found for a review).

1. **Prompt-stability test (no inference, decisive for P1/P2).** Render the section set twice with a
   running background job and a second of elapsed time between renders; assert the serialised section
   map is byte-identical, and assert the planned `pi.system` entries are empty on the second render.
   Fails today for `background`; this is the cheapest possible proof and it belongs in the committed
   test suite.
2. **Patch accounting (recorded data, no inference).** A script over `pi.usage` + entries that reports,
   per conversation: patches, average context, predicted vs measured uncached input, and the re-bill
   ratio. Run it on the existing data as the baseline, then weekly. It is the only number that says
   whether P1–P4 worked, and it needs no model calls.
3. **Faux-provider replays (no paid inference).** The harness ships a testing provider; drive a
   scripted review of a fixed fixture range (three seeded defects of known difficulty) and a scripted
   branch task (one file change, one test, one landing) through current and proposed configuration.
   Compare: billed tokens per bucket, hops, patch count, wall time, and whether the scripted tool calls
   still found the seeded defects. This isolates the _context policy_ from model behaviour.
4. **A small real A/B, only after 1–3 pass.** Two real branch tasks and one real review, run on the
   current and the proposed configuration, three runs each. Decide on cost per validated task and on
   the number of user steering turns; a change that saves 20% of tokens but adds one round of steering
   is not a saving.
5. **Rollout guard.** Ship P1 and P2 first (no quality surface). Ship P3 behind a setting, on one
   project, with the patch-accounting script and the reviewer's seeded-defect recall watched for a week
   before it becomes the default.

---

## 14. Summary

- Total: **$92.60** over 255 conversations: 54% uncached input, 25% cache read, 21% output, 215 prompt
  tokens per output token.
- The single biggest driver: **re-billing already-read context after a prompt-prefix change** —
  $2.59 of #48346's $2.88, $3.21 of #40's $4.71, ~$33 across the corpus.
- The reason it is that big: **nothing bounds the working set.** Every conversation runs on a
  1M-token-window model with no compaction configured, so average context per request is 259k and
  grows for the life of the conversation.
- The cheapest real fix is a few lines (`background` must not tick); the largest is a working-set
  budget. Together they are worth an estimated $30–45 of $92.60 without touching model choice, review
  independence or the prompt's substance.
