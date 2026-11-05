# Can a small local model choose which review dimensions a change needs?

An experiment, run read-only: a 0.8B and a 2B decision model on loopback, 22 historical work orders, 3 of
them with real reviewer verdicts. Nothing operational was changed — `agents/`, `.ultimate/` and settings are
untouched, and no code in `lib/review-routing/` has a caller in the app.

**The one sentence: no — three reviewed work orders cannot justify routing anything, both model arms silently
dropped findings an author then fixed, the deterministic rules keep everything for 5 % less, and the entire
prize for dropping both advisory passes is ≈ $0.16 per work order.**

|                                    | measured on this machine                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| independently reviewed work orders | **3** of 22 (14 %); 7 dimension verdicts, 6 of them actioned before landing                                  |
| achievable saving                  | **at most 42 %** of review spend, ≈ **$0.16** per work order (correctness stays)                             |
| rules only (B)                     | 2.77 reviewer runs per work order, **$0.363** per work order, **$0.383** per correct review, 0 findings lost |
| model alone (C 0.8B / D 2B)        | 1.3 runs, $0.250 spent, **$0.829 per correct review**, **2 findings lost each**                              |
| hybrid (E, fitted)                 | abstains on 11–19 of 22 work orders: **the full team, at full cost**                                         |
| local inference                    | 0.8B **576 ms** / 2B v4 **247 ms** warm (2.7 KB state), 1.4 / 3.5 GB of weights                              |

Everything below is reproducible from this repository: `research/review-routing/` holds the dataset, the
extractor, the harness, the raw results and the model install; `lib/review-routing/` holds the adapter.
Commands are in `research/review-routing/README.md`.

---

## 1. Where "which reviewers run" is decided today

There is no code that decides it. It is a sentence in a prompt, and the team is whichever `reviewer-*`
definitions exist:

| Where                                                                | What it does                                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents/reviewer.md:12-14`                                           | "If Available definitions lists any `reviewer-*`, lead them and do not review yourself… start **every** `reviewer-*` as a background subagent with the coordinator's task verbatim." |
| `extensions/subagents/server.ts:866-873`                             | Renders `Available definitions` into the lead's prompt — the only place a choice could be injected.                                                                                  |
| `agents/reviewer.md:16-18`, `:28-40`                                 | The lead merges the reports and answers APPROVED / NEEDS CHANGES. Nothing else decides a verdict.                                                                                    |
| `.ultimate/agents/reviewer-{correctness,architecture,simplicity}.md` | The three dimensions this project runs: `family: review`, `tools: [read, bash]`, read-only.                                                                                          |
| `lib/agents.ts:395`                                                  | `discoverAgents` — which definitions exist, whether a project file replaces a built-in (`extensions/subagents/definitions.tsx:379-390` is the editor dialog over it).                |
| `extensions/workspaces/lander.ts:617-663`                            | The lander's gate: it runs the configured checks, merges, pushes. **It has no notion of review.**                                                                                    |

So a feature flag can sit beside the decision without touching a verdict: filter the `reviewer-*` entries that
`server.ts:866-873` renders, and the lead starts a subset. It changes _who runs_, never how reports merge or
what the coordinator concludes. Review coverage today is not even enforced: the lander would land an
unreviewed change, and 19 of 22 work orders in the dataset prove it.

**Correctness is not part of the question.** The router hardwires it on (`lib/review-routing/router.ts`, the
`fixed()` decision) and `test/review-routing.test.ts` asserts it for every case, including when the model is
down. A router that could turn it off is not a router, it is a different review process.

## 2. The dataset — and why it is 22, not 50–100

| Source                                                                     | Count                                      |
| -------------------------------------------------------------------------- | ------------------------------------------ |
| branch conversations of this project                                       | 29                                         |
| with commits that landed on the target                                     | 22 (`research/review-routing/cases.jsonl`) |
| that were **independently reviewed**                                       | **3**                                      |
| reviewer verdicts recorded (`event.subagents.started`, `agent: reviewer*`) | 7 runs: 2 full teams + 1 solo              |

The brief asked for 50–100 labelled cases. They do not exist: this project started using the review team on
2026-10-30 and has recorded three reviews since — two with the whole team (conversations 4005/4201/4223/4234
and 15240/15289/15311/15322) and one with a single correctness reviewer (23882). No other project on this
machine is running, so the "another project with unambiguous authorisation" route was closed, and re-running
reviewers on old ranges would have meant paying for inference the brief forbids. Inventing labels was the
other option and it is not one: what is here is 22 cases of real pre-review facts, **3 of them labelled**.

### How the features were built (deterministic, pre-review)

`research/review-routing/extract.ts` derives every feature from git plumbing output: the work order's own
commits (each measured against its own first parent, so work merged in from the target never inflates a case),
their paths, line counts, new/renamed files, layers (`server/`, `shared/`, `web/src`, `lib/`, `extensions/x`,
`test/`, `docs/`), contract markers (`api.ts`, `refs.ts`, an agent definition), schema markers
(`shared/protocol.ts`, `shared/events.ts`, storage), dependency and build config, security markers (secrets,
auth, `owned-env`, `spawn`, `process-group`, the HTTP surface), `bin/`, and test changes. Commit subjects give
the work-order type. Nothing reads a verdict, a finding, a cost or a reviewer name.

`node research/review-routing/extract.ts --check` re-derives all of it, refuses drift, refuses a duplicate case
id, refuses a label without a recorded review, and refuses any absolute host path. The three recorded review
ranges were reproduced from git: `merge-base` of the reviewed head with the target gives `7616eaa9` for
`wo-3055` and `7d088f5b` for `wo-22139` exactly; `wo-13069`'s recorded base is one trailer-less commit
(`42b54af3`) earlier than the recomputed fork point, which the check reports rather than hides.

### How the labels were built (hand, from the record)

`actioned` is the label that matters: **a finding the coordinator acted on before landing blocks, whatever
priority the reviewer gave it.** Both are checks against the record, not opinions. `research/review-routing/labels-notes.md` lists every label with its finding and the commit that addressed it.

| work order                     | architecture                                                                                          | simplicity                                                                         | correctness                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `wo-3055` composer input seam  | **actioned** (P3: no boundary, no name → landed carries `{extension, version}`)                       | **actioned** (P3: unused SDK exports → removed)                                    | **actioned** (P3: precedence comment inverted → iteration order reversed) |
| `wo-13069` jobs + owned shells | **actioned** (2×P2: card at-most-once, duplicated log routine, a boundary crossing by string literal) | **actioned** (2×P2: no test for dead-leader adoption, whole-log rewrite per chunk) | not actioned (P3: spill truncated after `finish()` — left as is)          |
| `wo-22139` review switch-back  | never ran                                                                                             | never ran                                                                          | **actioned** (P2: `switchBack` drops the pending return)                  |

That table is the whole ground truth: **six actioned findings across seven dimension labels**. In both fully
reviewed work orders _every_ dimension produced something the coordinator fixed.

## 3. The adapter

`lib/review-routing/` — 5 modules, no dependency, no caller in the app:

- `facts.ts` — the fact type and its derivation from git plumbing text (pure).
- `rules.ts` — the deterministic baseline and the safety floor: seven overrides that force the full team
  (`dependency`, `schema`, `supervisor`, `checks-failed`, `unknown-type`, `no-diff`, `large > 600 lines`).
- `jev.ts` — the local model client for `POST /v1/systemone` (the same request shape as
  `extensions/classify/README.md`), a 15–20 s cap, and a typed `JevError` for unreachable / timeout / HTTP /
  malformed. A server that is down, slow or answers the wrong shape is an abstention, never a guess.
- `router.ts` — `route(facts, options) -> Decision`: per-dimension probability + evidence + uncertainty,
  deterministic overrides, abstention near a threshold, and the switch that runs the model arm alone.
- `types.ts` — the vocabulary. There is no field for approve, deny, blocking or verdict: a `Decision` says
  which reviewers to start, and `test/review-routing.test.ts` asserts that shape has no verdict in it.

The third output is `enhanced`: not a reviewer, an argument for calling the security and durability angle out
explicitly in the review request, which costs nothing and runs nobody. It takes the model's answer when there is
one and the rules' path markers otherwise, it flips above `enhancedAbove = 0.4`, and it deliberately keeps a low
number even when an override forces the whole team — a flag that costs nothing has no reason to pretend to know
more than the model said.

Shadow mode, honestly: the router computes a decision for every work order and the harness records it beside
the real outcome (`research/review-routing/results/decisions.json`). It is wired to nothing and can affect
nothing — no commit, merge, verdict or workflow reads it. A live shadow would need exactly one change, the
definition filter at `server.ts:866-873`, and that change is deliberately not in this branch.

**What the adapter cannot see**, and should: the work order's acceptance criteria. They live in the
coordinator's prompt and the plan ledger; extracting them is the next real piece of work, and the rules treat
a missing type or a missing diff as "run everything" meanwhile.

## 4. The model actually verified

Both releases came from `jev-style` 0.6.3 (PyPI), MLX backend, `mlx-lm` 0.31.3, Python 3.12.8, weights Apache-2.0
(`research/review-routing/model-setup.md` has the exact commands, model repo revisions and error behaviour):

|                   | Jev-Style-0.8B-Decision-v3 (`--release 0.8b`) | Jev-Style-2B-Decision-v4 (`--release 2b`) |
| ----------------- | --------------------------------------------- | ----------------------------------------- |
| warm median / p95 | 575.6 / 593.2 ms (2.7 KB state)               | 247.2 / 278.3 ms                          |
| cold load         | 6.2 s                                         | 4.7 s                                     |
| weights on disk   | 1.4 GB                                        | 3.5 GB                                    |
| RSS after a run   | 80.7 MB                                       | 177.2 MB                                  |
| upstream JevBench | 64.1 %                                        | 74.9 % (self-run)                         |

Two things that matter for a production plan:

- **The 2B is faster than the 0.8B here**, on every input of router size; on a 150-byte state the order
  flips (43 vs 53 ms). Latency is not the reason to prefer the small model.
- **RSS is not a usable memory figure** for MLX: reads ranged 78–131 MB and 173–1126 MB on the same idle
  processes, and `footprint` reports 5.1 / 4.6 GB phys_footprint for 1.4 / 3.5 GB of weights. The weight size
  is the only honest bound.
- **0.6.3's local server checks neither `Host` nor `Origin`** (measured: `Host: example.com` → 200), though
  upstream's README describes 403s. On loopback with no key that is the whole access control. Do not expose
  the port.

## 5. The experiment

Strategies, all on the same 22 cases, thresholds fitted on the even-indexed half (which contains exactly **one**
labelled dimension) and scored on the odd-indexed half (six labelled dimensions, five actioned):

| #   | strategy                                     | reviewer runs per work order | corr/arch/simp | est. cost per work order | held-out recall | actioned findings lost | local latency |
| --- | -------------------------------------------- | ---------------------------: | -------------- | -----------------------: | --------------: | ---------------------: | ------------: |
| A   | baseline: the full team                      |                         3.00 | 22/22/22       |                   $0.383 |            1.00 |                      0 |             — |
| B   | **deterministic rules only**                 |                         2.77 | 22/21/18       |               **$0.363** |        **1.00** |                  **0** |             — |
| C   | 0.8B, model alone                            |                         1.32 | 22/2/5         |                   $0.250 |        **0.60** |                  **2** |        242 ms |
| D   | 2B v4, model alone                           |                         1.36 | 22/6/2         |                   $0.250 |        **0.60** |                  **2** |        339 ms |
| E8  | hybrid: 0.8B + overrides + abstain (fitted)  |                         3.00 | 22/22/22       |                   $0.383 |            1.00 |                      0 |        242 ms |
| E2  | hybrid: 2B v4 + overrides + abstain (fitted) |                         3.00 | 22/22/22       |                   $0.383 |            1.00 |                      0 |        339 ms |
| F8  | 0.8B + overrides, hand-set 0.5 threshold     |                         2.64 | 22/21/15       |                   $0.351 |            1.00 |                      0 |        242 ms |
| F2  | 2B v4 + overrides, hand-set 0.5 threshold    |                         2.64 | 22/21/15       |                   $0.351 |            1.00 |                      0 |        339 ms |

Cost per **correctly reviewed** work order — the brief's metric, spend over the labelled work orders whose
every actioned dimension still ran:

| strategy  | spend on the 3 labelled work orders | correctly reviewed | cost per correct |
| --------- | ----------------------------------: | -----------------: | ---------------: |
| A / E / F |                          3 × $0.383 |             3 of 3 |       **$0.383** |
| B         |                          3 × $0.383 |             3 of 3 |       **$0.383** |
| C / D     |                        $0.829 total |         **1 of 3** |       **$0.829** |

Cheaper per invocation, twice as expensive per _correct_ review. That inversion is the experiment's answer in
one line: a skipped reviewer that was needed costs a rework cycle, and this project has no rework cycle in the
sample.

**Agreement with the rules' run set:** C 5 %, D 9 %, E 82 %, F 86 %. The two models do not agree with each
other either (they drop _different_ dimensions), which is what noise looks like, not what a signal looks like.

**No strategy's routing decision was ever exercised on a labelled work order — except the model's own.** All
three labelled work orders hit a deterministic override (two by `large > 600 lines`, two by `checks-failed`),
so B, E and F ran the full team on every one of them: their recall of 1.00 is the overrides' achievement and
proves nothing about routing. The rules only ever dropped a dimension on the four unlabelled small work
orders. The two arms that did route on labelled work orders are C and D, thresholds and all, and they lost
two findings each. In other words: the safety comes from the floor, and the part that would actually save
money is untested, while the part that was tested is wrong.

**The model does not decide most cases where the hybrid looks good.** In F8 the model made the call on 7 of 22
work orders; the other 15 were forced to the full team by the overrides. Everything the model contributed on
top of the rules was the simplification of unlabelled cases.

**Local latency here is 242 ms (0.8B) and 339 ms (2B)** for the harness's own ~700-byte state, lower than §4's
figures because that measurement used a 2.7 KB body; across the harness runs the medians were 224–242 ms and
315–339 ms, and the order between the two releases flips with input length, so neither is "the fast one".

**Failure path, measured.** With nothing listening, every model strategy abstained on all 22 cases (mode
`full-team`, override `model-unavailable`) and made zero model calls
(`research/review-routing/results/summary-offline.json`). The router cannot quietly decide on a dead model.

**Actual vs simulated cost.** Measured, from `pi.usage` of the nine reviewer conversations that ran: $0.3311
(`wo-3055`'s team), $0.4338 (`wo-13069`'s team), $0.0882 (a solo review) — $0.8531 in total, and $0.383 per
reviewed work order with the current team. Every other number above is **estimated** by applying those
measured per-reviewer costs to the run set a strategy chose: no reviewer was re-run, no provider was called,
and local inference is free in money but not in time. Estimated totals across the 22 work orders: A $8.42,
B $7.99, C/D $5.50, E $8.42, F $7.73.

## 6. Every finding a router would have lost, individually

All four sit in the held-out half. Each is one an author acted on, with the reviewer's own conversation as the
source, and each cause is the model's probability against the fitted threshold.

| #   | case                           | dimension    | source          | the finding that would have been missed                                                                                                                                                                | cause                           |
| --- | ------------------------------ | ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 1   | `wo-3055` composer input seam  | architecture | reviewer #4201  | what a handler `show`s renders as core UI with no boundary and no name — fixed before landing by carrying `{ extension, version }` and wrapping the node                                               | 0.8B p = 0.49 vs threshold 0.70 |
| 2   | `wo-13069` jobs + owned shells | simplicity   | reviewer #15289 | the dead-leader adoption branch has no test, and `append` reads and rewrites the whole log per chunk — both fixed                                                                                      | 0.8B p = 0.27 vs threshold 0.30 |
| 3   | `wo-3055` composer input seam  | simplicity   | reviewer #4223  | the SDK exports two constants nobody uses — removed before landing                                                                                                                                     | 2B p = 0.34 vs threshold 0.40   |
| 4   | `wo-13069` jobs + owned shells | architecture | reviewer #15322 | the finish card is at-most-once (`reported` set before the card exists), the log routine duplicates automations', and the leftover count crosses a boundary through a string literal — all three fixed | 2B p = 0.49 vs threshold 0.70   |

Not one of the four is a rounding error: two are the _only_ simplicity findings that changed code in a
1,700-line range, one is the finding that turned a "ship with notes" review into a fix, and one is a
durability bug (a card lost across a crash).

The rules lost nothing, because on this sample their overrides (both ranges are > 600 lines, one also had
`checks-failed`) keep the full team, and outside those they only dropped simplicity on four small work orders.

## 7. The rules versus the model, plainly

**The deterministic rule set does as well as either model, and better than the model alone.** It keeps recall
at 1.00 with 0 findings lost, it costs $0.020 less per work order (5 %), it needs no server, no 1.4–3.5 GB of
weights, no 220–580 ms and no failure mode — and its reasoning is a line of arithmetic a reviewer can argue
with. Neither model reaches its recall even when wrapped in the same overrides; both lose findings the rules
keep.

The honest caveat is not symmetric and it cuts against the rules too: with six labelled findings, "B loses
nothing" is a statement about _two work orders that its own overrides never routed_. The rules' actual
routing decisions — the four small work orders where it dropped simplicity — have no ground truth at all. So
the defensible reading is: the rules' **floor** is justified by the evidence, its **routing** is not, and no
number in this audit supports dropping an architecture or simplicity pass on a change nobody has labelled.

## 8. Recommendation

**Do not route reviews with a model. Keep the full team. If anything is automated, it is the rules, and only
as a floor.** Concretely, in order:

1. **Change nothing operationally.** Correctness stays independent and unconditional; architecture and
   simplicity stay unconditional too, because the only two work orders with evidence both needed them.
2. **If a review-coverage problem is worth solving, solve it with the rules, not the model**: gate a
   dimension on the seven overrides in `lib/review-routing/rules.ts` and require a human to accept any drop.
   Expected saving: 5 % of review spend, ≈ $0.02 per work order. That is the whole prize.
3. **Do not put the model in the path** for a 5 % prize: 1.4–3.5 GB of weights, a per-request 0.22–0.58 s, a
   failure mode that silently doubles the team, and — measured — two lost findings on a six-finding sample.
4. **If someone wants to try again, instrument first**: wire the shadow filter at
   `extensions/subagents/server.ts:866-873` behind a flag that only _records_, accumulate ~50 reviewed work
   orders with `actioned` labels (the label this experiment found to be the honest one), and re-run
   `research/review-routing/harness.ts`. The dataset pipeline already computes everything else from git, so
   adding a case is one line in `work-orders.json` plus one entry in `labels.json`.

What would change the answer: a sample where most dimension verdicts are negative (say 40 reviewed work
orders with 30 "nothing actioned"), so that skipping a dimension is right most of the time instead of half the
time — and where the model separates those two populations. On the current data the model's probabilities for
the work order that needed architecture (0.49) and a test-only change (0.14, and unlabelled, so no claim
about it goes beyond the model's own output) are far apart only in one direction: the model separates the
trivial from the ordinary, not the ordinary that needed a reviewer from the ordinary that did not.

## 9. Limitations a reader should weigh

- **n = 3 work orders, 7 dimension labels.** Nothing here can calibrate a threshold; the fitted half saw one
  label. Read every recall figure as "on these two work orders", not as a rate.
- **"Actioned" is a proxy for "blocking".** It is the strongest label the record supports (the change was
  altered because of the finding), and it is stricter than the reviewers' own priorities: three of the six
  were P3. A reviewer's P2 that the coordinator ignored would count as not actioned — `wo-13069`'s
  correctness pass is the mirror case.
- **The features are approximations of what a person knows.** No acceptance criteria, no plan, no intent, no
  reading of the diff's content, and the "security"/"schema" markers are path heuristics, not analysis. The
  `validation` field comes from the lander's recorded check runs — the same commands the coordinator runs
  before asking for review — and can only ever force the full team, never the other way.
- **One machine, a handful of runs.** M1 Max 32 GB, macOS 27.2, one client in sequence; the 2B's cold-load advantage
  partly reflects a warm file cache, and the two models were measured with different processes.
- **The 22 cases are this project's own history**, including two upstream-sync work orders whose "own change"
  is a merge. They are marked `changeType: unknown` and force the full team, so they cannot flatter a router.
- **Review coverage was 14 %.** Whatever the router does downstream, the bigger number in this audit is that
  19 of 22 landed work orders were never independently reviewed at all.
