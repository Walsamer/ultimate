# Jobs

Runs work that outlives the call that started it — a benchmark, a dev server, a watcher — as its own process group, with
a log, a pid and one card when it ends. The `background` tool does this; `bash` is for work that finishes inside the
call.

## Why

Every shell an agent runs is a drained process group ([owned-env](../../server/owned-env.ts)): when a `bash` call
returns, whatever its command left running is stopped, and the call says so — `Stopped 1 process the command left
running. Use the background tool for work that should outlive the call.` Work that deserves to keep running goes through
`background` instead, which can be inspected (`list`, `log`), stopped (`stop`), and reports its end in the conversation
that started it.

## The tool

`background { action }`:

- `start { command, cwd?, label? }` runs the command as a job and returns its id (`J1`, `J2`, …), its pid and the path
  of its log. It never waits for the job. The command runs in `cwd` resolved against the conversation's directory (the
  bash tool's), through `/bin/bash` when it exists and `/bin/sh` otherwise.
- `list` → one line per job: id, state, how long it ran or has been running, the command's first line and its pid.
- `log { id, lines? }` → the job's state line and the last `lines` lines of its output (default 50, at most 2000).
- `stop { id }` → stops the job's whole process group, then reports its state. Idempotent: a job that already ended says
  how it ended instead of throwing.

A job reads `J1 running · 3m: npm run bench (pid 1234)`. Its state is `running`, `running (completion unknown)`,
`exited 0` / `exited 3`, or `stopped`. The system prompt carries one line per running job, or `None running.`, so
the model knows what already runs instead of starting it twice. There the elapsed time is the job's start time
instead (`J1 running · started 2026-11-04T13:22:07.000Z: npm run bench (pid 1234)`): a value that changes every
second changes the prompt prefix with it and costs the provider's cache for every request while a job runs.

`start` is recorded against the tool call's id in the ledger: a call replayed after a crash answers with the job it
started instead of starting a second one.

## Files

`<home>/jobs/<id>/`, next to the project's other instance state:

- `pid` and `pid.start` — the group's leader and its start time, written by `spawnGroup`; the start time is what lets a
  later process prove the pid is still ours before it signals it.
- `output.log` — stdout and stderr, appended. After each append the log keeps its last 2001 lines, and at most 256 KiB
  of those.
- `commits.log` — the job's own commit log, below.

A job's pid file is not under `<home>/shell`, where a crash's leftovers are swept: a job outlives the host that started
it on purpose, so it is adopted instead (see below).

## Commits

A job carries the Git hooks a bash call carries ([commit-log](../../lib/commit-log.ts), `prepareBash`), pointed at its
own `commits.log`: every commit it makes gets `Ultimate-Conversation: <its conversation>` and is logged there. It never
inherits a bash call's hooks — those name the call's log file, which goes away when the call returns. When the job ends,
its log is read with `madeCommits` and each commit emitted once as `coding-tools.committed`, so a job's work shows up in
the lineage trail like any call's.

## End and adoption

A watched job's exit is one commit: state, exit code and end time, and — exactly once per job — a passive
`jobs.finished` entry in the conversation that started it. Its data is a `JobCard` (`types.ts`): how the job ended, its
log path, and `unknown` when nobody watched it end. `stop` claims its job before it signals it, so a stopped job's card
says `stopped` and the group's own exit writes no second one.

When the harness opens — after a restart, or after an extension reload — every job the ledger still holds as running is
looked at:

- its `pid` file still names its pid and its group is alive: it is marked adopted and left alone, never signalled and
  never rerun. It reports as `running (completion unknown)`: it runs, but nobody watches how it ends.
- otherwise it ended while nobody watched: it is marked exited (no exit code) and its card is written once, with
  `unknown: true`.

## What survives what

- A `bash` call: a job survives it. Nothing of a job is part of the call's process group, so the call's drain leaves it
  alone.
- Closing the harness (a core swap, a shutdown): a job survives it. `onClose` stops no job; it only drops the in-memory
  listeners, because an ordinary bash call's group dies with its environment's own `cleanup()` and a job's does not.
- An extension reload: a job survives it, and its output keeps going into `output.log` (that pipe is process state, not
  facet state). The reload's own `onOpen` drops nothing of a job whose group is still there; what it loses is the finish
  listener, so a job that ends after the reload is recorded on the _next_ open, as an unwatched end.

## Limits

The drain and this tool cover POSIX. On Windows the conversation environment keeps Pi's own `exec`, so a call there
stops nothing at its end and the leftover diagnostic never appears (a job still runs, as its own group's leader).
