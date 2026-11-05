# Every label, and why it is what it is

Three work orders were independently reviewed in this project. For each, the reviewers' own reports were read
in full, and then the commits the coordinator made afterwards, to decide whether the finding actually changed
the change before it landed. `actioned` is that: **a finding acted on blocks, whatever priority it was given** —
the simplicity pass in `wo-3055` labelled three of its findings P3 and one of them still reversed an iteration
order before landing.

Conversation ids name the reviewer's conversation in the state store; `Ultimate-Conversation` trailers name the
commits. Neither is part of the committed dataset — `cases.jsonl` carries the labels, this file carries the
evidence.

## wo-3055 — "Composer: extensions take drops and pastes through one input seam"

Reviewed `7616eaa9..066f6a46` by a lead (#4005) and three reviewers; all three answered **APPROVED**, all
findings P3. The landed commit is `3b55559`, which is not the reviewed tree: it carries the review's changes.

| dimension    | reviewer | verdict  | findings | actioned | what changed before landing                                                                                                                                                                                                                   |
| ------------ | -------- | -------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| correctness  | #4234    | APPROVED | 6 × P3   | **yes**  | Its first finding: "the precedence comment states the opposite of what it does". The landed `composerInputs` reverses the iteration order (`toReversed()`) and rewrites the comment — a behaviour change, not a comment fix.                  |
| architecture | #4201    | APPROVED | 5 × P3   | **yes**  | "What a handler `show`s renders as core UI, with no boundary and no name". The landed registry carries `{ extension, version }` per handler and the composer renders `composerInput.shown` through the boundary, exactly the suggested shape. |
| simplicity   | #4223    | APPROVED | 8 × P3   | **yes**  | "SDK exports two constants nobody uses". The landed `web/src/sdk/index.ts` exports `imageMimeTypes` alone.                                                                                                                                    |

## wo-13069 — "Jobs: a finished job's card, and owning every shell"

Reviewed `85d19428..af91500a` by a lead (#15240) and three reviewers; all three **APPROVED (ship with notes)**.
The follow-up commit `442afa8c` addresses three of the four P2 groups.

| dimension    | reviewer | verdict  | findings        | actioned | what changed before landing                                                                                                                                                                                                                                                                                        |
| ------------ | -------- | -------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| architecture | #15322   | APPROVED | 4 × P2, 6 × P3  | **yes**  | "The finish card is at-most-once (`reported` set before the card exists)" and "a job's log routine is a second copy of automations', plus the leftover count crossing the boundary through a string literal" — `442afa8c` reports the end before the card, trims the log cheaply, and adds `shared/shell-call.ts`. |
| simplicity   | #15289   | APPROVED | 2 × P2, 13 × P3 | **yes**  | "The dead-leader adoption branch has no test" and "`append` reads and rewrites the whole log on every output chunk" — `442afa8c` adds the test and keeps byte/line counters instead.                                                                                                                               |
| correctness  | #15311   | APPROVED | 6 × P3          | no       | "The spill file is truncated when output arrives after `spill.finish()`" was not addressed: the follow-up's only change in `server/owned-env.ts` is the `SHELL_CALL` import.                                                                                                                                       |

## wo-22139 — "Models: switch review back to its own model"

Reviewed `7d088f5b..6d26a6b3` by one reviewer (#23882), **NEEDS CHANGES**; no architecture or simplicity pass
ever ran for this work order, so both are `ran: false`.

| dimension    | reviewer | verdict       | findings       | actioned | what changed before landing                                                                                                                                                                                  |
| ------------ | -------- | ------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| correctness  | #23882   | NEEDS CHANGES | 1 × P2, 3 × P3 | **yes**  | "`switchBack` drops the pending return on unsettled login evidence" — fixed in `3c0b2d76`, with the test the review asked for in `a2fddafa`; the same commit names the family model, which was its first P3. |
| architecture | —        | —             | —              | n/a      | not run                                                                                                                                                                                                      |
| simplicity   | —        | —             | —              | n/a      | not run                                                                                                                                                                                                      |

## What this sample is

Seven dimension labels, six of them actioned. Two work orders with a full team, one with a single reviewer.
That is enough to show what a router would have had to get right, and nowhere near enough to calibrate a
threshold: see `docs/audit/review-routing.md` §6.
