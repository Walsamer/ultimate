# Review routing: the experiment's artifacts

Everything here backs `docs/audit/review-routing.md`, which holds the analysis and the recommendation.
Nothing in this folder runs in production, and no code in `lib/review-routing/` has a caller in the app.

| File               | What it is                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `work-orders.json` | The 22 work orders, one per landed branch conversation of this project, pinned to an explicit head sha.                                      |
| `labels.json`      | Ground truth for the 3 work orders that were independently reviewed, read by hand from the reviewers' reports and the commits that followed. |
| `labels-notes.md`  | Every label with the finding it came from and the commit that addressed it.                                                                  |
| `extract.ts`       | Builds `cases.jsonl` from git; `--check` verifies the committed file and the dataset's invariants.                                           |
| `cases.jsonl`      | The dataset: features, provenance, and labels where a real review exists.                                                                    |
| `harness.ts`       | Runs strategies A–F over the dataset against a live local server; writes `results/`.                                                         |
| `results/`         | Per-case decisions (`decisions.json`), the summary (`summary.json`), and the same run with the model down (`*-offline.json`).                |
| `model-setup.md`   | How the local decision model was installed and what it measured on this machine.                                                             |

## Reproduce it

```bash
# 1. the local decision model (details and versions in model-setup.md)
/opt/homebrew/bin/python3.12 -m venv ~/.ultimate/jev/venv
~/.ultimate/jev/venv/bin/pip install "jev-style[mlx]"
~/.ultimate/jev/venv/bin/jev-style download --release 0.8b
~/.ultimate/jev/venv/bin/jev-style download --release 2b
HF_HOME="$HOME/.ultimate/jev/hf" ~/.ultimate/jev/venv/bin/jev-style serve --host 127.0.0.1 --port 8765 &
HF_HOME="$HOME/.ultimate/jev/hf" ~/.ultimate/jev/venv/bin/jev-style serve --host 127.0.0.1 --port 8766 --release 2b &

# 2. the dataset and its invariants
node research/review-routing/extract.ts --check

# 3. the experiment (writes results/), or with nothing listening at all
node research/review-routing/harness.ts
JEV_URL_08B=http://127.0.0.1:8799 JEV_URL_2B=http://127.0.0.1:8799 node research/review-routing/harness.ts --offline

# 4. the router's own tests (no network, no model)
TMPDIR="$HOME/.ultimate/tmp" npx vp test test/review-routing.test.ts
```

The venv and the weights live under `~/.ultimate/jev/` — never inside a project's `extensions/` folder, which
a file watcher reloads and which a multi-gigabyte venv has taken down before.

## How a case is built, and what it may not contain

- **The range.** A work order is the set of commits whose `Ultimate-Conversation` trailer names its branch
  conversation. `base` is the recorded review base where a review happened, otherwise the parent of the oldest
  of those commits. Both are pinned in `cases.jsonl`; `--check` re-derives them and fails on any drift.
- **Features come from the range alone** — paths, line counts, areas, contract/schema/dependency/security
  markers, test changes, commit subjects. No verdict, no finding, no cost, no reviewer name. Everything in a
  case could have been computed before the review started.
- **Merges are not counted as the work order's own change.** Each commit is measured against its own first
  parent, and a merge that only syncs the target is skipped, so work merged in from elsewhere never inflates a
  case. A work order that exists only as merges is measured by them.
- **Labels only where a reviewer ran.** Three work orders were independently reviewed in this project; a
  dimension that never ran is `ran: false`, which is insufficient evidence, not a negative.
- **No host paths.** Git subjects can name the machine a commit came from; they are scrubbed to `<path>` and
  the check fails if any absolute path survives.
