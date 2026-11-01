Ultimate's awareness of its own code: the replay-safe `restart` tool requests a type-checked core swap from the supervisor (`pnpm start`). Failed preparation returns diagnostics while the old core continues. The tool saves the next generation before activation; replay reports the running generation or activation rollback.

Call after authorized changes to `server/` or `shared/`. Never call for `web/`, `extensions/`, or `agents/`: those reload without a core swap.

An isolated conversation whose workspace **is** the running Ultimate clone must first land into it: restart requires that clone to be clean and its HEAD to equal the workspace's saved landed commit, otherwise it asks you to land first. A workspace of another project — and a shared conversation, including one in a project subdirectory — uses ordinary restart behavior, since it lands into its own project and its tip can never be the clone's HEAD. The running clone must be clean either way, because it is the code the swap loads; a dirty one is refused with the files to commit or discard.

Restart affects all conversations. Landing never restarts automatically. `POST /api/restart` requests the same swap; reconnect to `/api/events` to observe readiness.

`web.tsx` renders restart results, build information, and transcript reload markers. While `server/` or `shared/`
changed since this core booted, the status line shows `core changed · restart` just left of `live · gen N`; clicking
it restarts the host, and a failed restart turns it into `restart failed` with the reason in a popover.
When Vite applies a hot update without reloading the page, a quiet toast above the bottom right of the status line
names the modules it re-ran for 3 s; updates arriving meanwhile join it. Tailwind's stylesheet, rebuilt on every
source change, is named only when nothing else changed.
