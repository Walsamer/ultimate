# Model strategy

The one place that says which model each role runs on. Families live in `~/.ultimate/model-families.json`
(machine-wide, the `recent` entry and every project entry) and a project's `.ultimate/settings.json`; this document
describes the intent, not a copy of the numbers, because the numbers changed four times in two days.

## The shape

- **Free tier for bounded work.** Roles whose session is re-created per task — summaries and titles, `scout`, `watcher`,
  `sketch`, `dream-pass`, previews — run on free Telekom LLMhub models first, with a declared chain of further free
  models and the paid API last. They hold no long-lived state, so a refusal costs a retry, not a conversation.
- **Paid or subscription for continuity.** `@ultimate` and branch coordinators carry a tree's state and reach hundreds
  of thousands of tokens; `design` produces work judged by eye. They run on a large-window model, never on a small one.
- **Review stays on Codex.** Its three reviewers run on a subscription model and fall back to the paid API, and when
  Codex is out the family returns to it at the moment the provider names.

## The rules that matter more than the table

1. **A model switch must never silently condense a conversation.** Pi recomputes its compaction threshold from the
   destination model's window on the next turn and compacts before sending. A chain that can reach a smaller window is
   therefore a chain that can replace working state with a summary. `docs/audit/model-routing.md` has the measurements;
   a candidate whose window cannot hold the conversation is skipped, and a manual switch asks first.
2. **A free model's refusal must never pause the host.** A 429 on a free model marks that model and moves to the next
   entry in the chain; the pause is for a limit that stops *paid* work, not for a free tier doing what free tiers do.
3. **Free models are disabled until a person re-enables them** once their quota is hit, per model first, provider-wide
   only after a second different model refuses. Nothing falls through to a paid provider without the chain saying so.
4. **Windows are working sizes, not maxima.** An advertised 1M window with a 35k input-tokens-per-minute allowance
   cannot serve a 300k request. Each hub model declares a `contextWindow` it can actually be served with.
5. **Providers must be visible to the host.** `~/.pi/agent/models.json` is read at start, so a family naming a `llmhub`
   model means nothing to a process started before that provider existed.

## Where the configuration lives

| What | Path | Scope |
| --- | --- | --- |
| Families, per project and machine-wide | `~/.ultimate/model-families.json`, `<project>/.ultimate/settings.json` | project wins over user, field by field |
| Provider definitions and model windows | `~/.pi/agent/models.json` | this machine |
| Compaction thresholds by model | `server/harness.ts` `compactionOverrides`, or `compaction.modelOverrides` in Pi's settings | clone / user |
| Which agents exist and their family | `<project>/.ultimate/agents/*.md`, `~/.ultimate/agents/` | project over user over built-in |
