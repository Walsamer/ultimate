This is Ultimate's own repository, and this setup is the one it is built with: Ultimate plans, delegates, checks its
work, and changes its own code while you talk to it.

## What it adds

Every built-in is already on; this setup adds how the repository is landed and reviewed:

- `settings.json`: each worktree isolate installs its dependencies, and the lander runs `pnpm check`, then
  `pnpm test` and `pnpm test:e2e` in parallel, and pushes to `origin`.
- `settings.json`: the `tiny` family (titles and summaries, `scout`, `watcher`, `sketch` and the dream's passes) runs
  the four free models of this machine's Telekom LLM hub first, then the paid DeepSeek API: `llmhub/Qwen3.6-35B-A3B-FP8`,
  then `NVIDIA-Nemotron-3-Super-120B-A12B-FP8`, `Mistral-Small-4-119B-2603` and `gemma-4-31B-it-FP8` as its fallback,
  ending on `deepseek/deepseek-flash`. Those hub models are machine scope, not repository scope: they are registered in
  `~/.pi/agent/models.json` (provider `llmhub`, `openai-completions`, key from `~/.config/llmhub/key`) with a working
  200k window and a 32k answer budget each, so a machine without that registration runs the chain's last step only —
  a model without a login is not a candidate, so every step before it is skipped rather than retried.
- `agents/reviewer-*.md`: the review team (correctness, simplicity, architecture), each on its own model; the shipped
  `reviewer` starts them in parallel and returns one merged verdict.
- `extensions/drop/`: files dropped into the composer. A plain drop inserts the file's absolute path, looked up on this
  machine by name; a shift-drop copies the file into the conversation's own folder under the state home.

Not here, on purpose: the OpenDesign design-pull extension and its skill are user scope
(`~/.ultimate/extensions/opendesign/`, `~/.ultimate/skills/opendesign/`), so every project has them, not just this one.

To adopt parts of this setup in another project, ask its @ultimate for a tour (the `adopt-ultimate-setup` skill);
onboarding offers it too.

## How to work with it

See [the work model](../AGENTS.md#how-work-is-organised-a-forest-of-conversation-trees) for coordination and
[Surfaces](../README.md#surfaces) for apps beside the conversation.

## How it runs

See [reload layers](../AGENTS.md#layers-and-how-they-reload), [running the server](../docs/running.md) and
[durability](../docs/durability.md) before changing the running system.

## Read more

`README.md` to start, `AGENTS.md` for the reload layers and the rules, `extensions/README.md` to write extensions.
