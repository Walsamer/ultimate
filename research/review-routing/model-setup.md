# Review routing: the local decision model, installed and measured

The review-routing experiment asks whether a small local decision model can choose which review dimensions a code
change needs. This file records the model side of it: what was installed, how to reproduce it, what it answered, and
what it costs in time and memory on one machine. Nothing here relies on a mock or a fake engine; every number below
comes from real inference on the two releases.

Two servers were left running on loopback: the 0.8B (default release) on `127.0.0.1:8765` and the 2B v4
(`--release 2b`) on `127.0.0.1:8766`. Both are processes started by hand, not launch agents; nothing restarts them
after a reboot.

## 1. Reproduce from a clean machine

Apple silicon only: the MLX backend needs it, and `jev-style[mlx]` is the reason the model runs at all on a Mac
without CUDA. Everything lives outside any Ultimate project, under `~/.ultimate/jev/`.

```bash
# 1. Python 3.12 in its own venv (jev-style[mlx] pins mlx-lm to one exact version; do not share the venv)
/opt/homebrew/bin/python3.12 -m venv ~/.ultimate/jev/venv
~/.ultimate/jev/venv/bin/pip install -U pip

# 2. Install the package with the MLX extra
~/.ultimate/jev/venv/bin/pip install -U "jev-style[mlx]"

# 3. Keep the weights out of any project: point the Hugging Face cache at ~/.ultimate/jev/hf
export HF_HOME="$HOME/.ultimate/jev/hf"

# 4. Download each release explicitly, so a download failure is not mistaken for a server failure
~/.ultimate/jev/venv/bin/jev-style download --release 0.8b   # prints the snapshot folder it pinned
~/.ultimate/jev/venv/bin/jev-style download --release 2b

# 5. Two servers, one model each, loopback only (--host defaults to 127.0.0.1; never pass another host)
HF_HOME="$HOME/.ultimate/jev/hf" ~/.ultimate/jev/venv/bin/jev-style serve --host 127.0.0.1 --port 8765
HF_HOME="$HOME/.ultimate/jev/hf" ~/.ultimate/jev/venv/bin/jev-style serve --host 127.0.0.1 --port 8766 --release 2b

# 6. Check both are up
curl -sS 127.0.0.1:8765/healthz
curl -sS 127.0.0.1:8766/healthz
```

The package has no home directory of its own (`JEV_STYLE_HOME` does not exist in 0.6.3); `HF_HOME` is what decides
where the weights land, and the `jev-style download` output prints the snapshot folder it pinned, whose name is the
revision sha.

## 2. Exact versions

| Component                       | Version / id                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Python (`~/.ultimate/jev/venv`) | 3.12.8                                                                                                                                     |
| `jev-style`                     | 0.6.3                                                                                                                                      |
| `mlx` (and `mlx-metal`)         | 0.32.4                                                                                                                                     |
| `mlx-lm`                        | 0.31.3 (pinned by the `[mlx]` extra; the 2B runtimes refuse any other version)                                                             |
| `huggingface_hub`               | 2.4.0                                                                                                                                      |
| Backend                         | `mlx` (the `auto` choice on Apple silicon)                                                                                                 |
| Precision                       | default `bf16` — no `--precision 8bit`: accuracy over footprint, since 8-bit saves disk and memory but is a different build of the weights |
| 0.8B model repo                 | `chaoliangUNSW/Jev-Style-0.8B-Decision-v3-MLX`, revision `7f14c9fa1491d168a7f70b16acf68baf9d4f7353`                                        |
| 2B v4 model repo                | `chaoliangUNSW/Jev-Style-2B-Decision-v4-MLX`, revision `a14bbe4dafb154f0b05884314c8e227b1c6a5cd6`                                          |

`jev-style releases` prints both pins (`mlx chaoliangUNSW/Jev-Style-0.8B-Decision-v3-MLX @ 7f14c9fa`, `mlx
chaoliangUNSW/Jev-Style-2B-Decision-v4-MLX @ a14bbe4d`), and the downloaded snapshot folders carry the full shas.

One trap: `mlx` 0.32.4 has no `mlx.__version__`, so `python -c "import jev_style, mlx, mlx_lm; print(...,
mlx.__version__, ...)"` raises `AttributeError`. Read the versions from the metadata instead:

```bash
~/.ultimate/jev/venv/bin/python -c "import importlib.metadata as m; print('jev-style', m.version('jev-style'), 'mlx', m.version('mlx'), 'mlx-lm', m.version('mlx-lm'))"
# jev-style 0.6.3 mlx 0.32.4 mlx-lm 0.31.3
```

## 3. Measured numbers

Measured on this machine, not a vendor figure: an Apple M1 Max Mac with 32 GB of unified memory, macOS 27.2. Every
request in these runs carried the body in section 4 (2,779 bytes of state, 588 state tokens).

| Measurement                                                           | 0.8B v3 (`:8765`) | 2B v4 (`:8766`) |
| --------------------------------------------------------------------- | ----------------: | --------------: |
| Cold load, process start → `/healthz` answering                       |             6.2 s |           4.7 s |
| Warm latency, median (wall clock, n = 20)                             |          575.6 ms |        247.2 ms |
| Warm latency, p95 (wall clock, n = 20)                                |          593.2 ms |        278.3 ms |
| Warm latency, median of the server's own `latency_ms`                 |          572.5 ms |        240.1 ms |
| Warm latency, p95 of the server's own `latency_ms`                    |          581.8 ms |        253.2 ms |
| Resident set size right after the latency run (`ps -o rss= -p <pid>`) |           80.7 MB |        177.2 MB |
| Weights on disk (`du -shL` of the snapshot)                           |            1.4 GB |          3.5 GB |

How it was measured:

- **Cold load**: the process's start time was written to a file, the server was started, and `/healthz` was polled
  every 0.5 s until it answered 200; the difference is the number. The 2B started second, so part of its advantage is
  an already warm file cache — do not read the two as a ranking.
- **Warm latency**: three warmup requests, then 20 sequential requests with the same body, timing each with
  `time.perf_counter()` around the whole HTTP call and also recording the server's own `latency_ms`. p95 is the
  nearest-rank order statistic of the 20 samples; requests are one client, one after another. The probe is this, run
  with the venv's Python, `probe.py http://127.0.0.1:8765 3 20`:

  ```python
  import json, statistics, sys, time, urllib.request

  url, warmup, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
  body = open("body.json", "rb").read()
  results = []
  for i in range(warmup + n):
      t0 = time.perf_counter()
      req = urllib.request.Request(url + "/v1/systemone", data=body,
                                   headers={"content-type": "application/json"})
      with urllib.request.urlopen(req, timeout=600) as r:
          payload = json.load(r)
      if i >= warmup:
          results.append(((time.perf_counter() - t0) * 1000, payload["latency_ms"]))

  wall = [r[0] for r in results]
  srv = [r[1] for r in results]
  p95 = lambda xs: sorted(xs)[min(len(xs) - 1, int(round(0.95 * len(xs) + 0.5)) - 1)]
  for name, xs in (("wall_ms", wall), ("server_latency_ms", srv)):
      print(name, "median", round(statistics.median(xs), 1), "p95", round(p95(xs), 1))
  ```

- **Memory**: `ps -o rss= -p <pid>` in MB, taken immediately after each latency run, with
  `ps -o pid=,command= -p <pid>` for the pid and command line. pids at the time of measurement were 55525
  (`jev-style serve --host 127.0.0.1 --port 8765`) and 55787 (`jev-style serve --host 127.0.0.1 --port 8766
  --release 2b`).

**RSS is not a usable memory figure for these processes, and the table should not be read as "the 2B costs 177 MB".**
On Apple silicon MLX keeps the weights in Metal buffers that macOS does not attribute to the process the same way it
attributes ordinary resident pages. Readings taken minutes apart on the same idle processes ranged from 78 to 130 MB
for the 0.8B and from 173 to 1126 MB for the 2B; `footprint -p <pid>` reports a `phys_footprint` of 5.1 GB for the 0.8B
and 4.6 GB for the 2B, which is not proportional to the weight sizes either. The honest bound for what each server
needs is the weights on disk (1.4 GB and 3.5 GB). Budget by that: the two releases together are 4.9 GB of weights,
before the runtime and the KV cache, and they stay resident while both servers run.

`du -sh` of the snapshot folder understates the download: the files are symlinks into `~/.ultimate/jev/hf/hub/blobs`,
which holds 4.9 GB for both releases together. Use `du -shL` on the snapshot, as above.

## 4. The serving contract

- Base URLs: `http://127.0.0.1:8765` (0.8B v3) and `http://127.0.0.1:8766` (2B v4). Health: `GET /healthz`, models:
  `GET /v1/models`, a browser Playground at `/`. The decision route is `POST /v1/systemone`.
- No API key by default (`"auth": false` in `/healthz`). 0.6.3 does no host or origin check: a request with
  `Host: example.com` and one with `Origin: https://evil.example` both answered 200 here, although upstream's README
  describes 403 `forbidden_host` / `forbidden_origin` and an `--allow-any-host` flag that do not exist in this version's
  `serve` command. The loopback bind is the only thing keeping other machines out.
- One request carries one state and all its questions; the state is read once and each question is scored over it, so
  adding a question costs less than adding a request.

The exact request body used for every measurement above:

```json
{
  "state": "Change description: the workspace submit path now retries a rejected push once before giving up. What changed: server/integration.ts gained a retryPush() helper that re-runs the fetch and force-with-lease comparison when the first push is rejected with a non-fast-forward, and lib/push.ts exports the rejected-ref parser it uses. The lander calls retryPush() around its existing push call, and it records a 'push_retried' event with the lease sha, the attempt count and the remote ref so the log shows what happened. Why: two of the last five failed landings on the main branch were remote advancement, where another machine had pushed between our fetch and our push. Each one woke the branch, which then waited for a person to look at a conflict that was not a real conflict: the two sides touched different files. The retry re-fetches, merges in an isolate when the files really overlap, reruns the checks and pushes again. When the same pattern repeats twice in a row the push is not attempted a third time and the landing fails with the reason it failed. Files touched: server/integration.ts (about 90 lines changed), lib/push.ts (20 lines, parser moved out of server/), test/integration.test.ts (four new cases: clean retry, overlapping files, a second rejection, and a network error that must not be retried). No database migration, no API change, no new dependency; package.json is untouched. The retry runs on the lander's own worker, one at a time per landing, and it keeps no state between landings. Acceptance criteria: a rejection caused by remote advancement lands after exactly one retry and the log shows it; an overlapping conflict stops the retry, reports the conflicting paths and does not force anything; a second rejection in the same landing stops instead of looping; a network error surfaces unchanged with no retry; the existing 41 integration tests still pass and the new four cover the cases above; the push permission rules in AGENTS.md are unchanged, so nothing here allows a force push or a push to another repository. Review notes: the retry holds the landing's checkout for up to thirty seconds, which could delay a queued second landing on the same worktree; the parser moved to lib/ because both server/ and the new helper need it, and it has no behaviour change; the event is additive so existing log renderers ignore it; nothing in the change reads user input, opens a socket to a new host, or writes outside the worktree. Risk assessment so far: low for the merge path, medium for the locking, since a long retry can now overlap a second submission more often than before. The branch that asked for this reported it as a flaky landing, not as a feature, so the smallest fix that removes the false conflict is preferred over a scheduler rewrite.",
  "questions": {
    "security_review": {
      "type": "noul",
      "instructions": "The change alters how untrusted input reaches a privileged operation.",
      "criteria": {
        "true": "Parses, forwards or stores input from a user, a network peer or an untrusted file before a privileged action.",
        "false": "Only touches values the process itself produced, such as paths, shas and counters it read back from git."
      }
    },
    "performance_review": {
      "type": "noul",
      "instructions": "The change can make a hot request path slower or hold noticeably more memory.",
      "criteria": {
        "true": "Adds work per request, per token stream or per conversation to code that runs on every one of them.",
        "false": "Adds work only to a rare, explicitly triggered path such as a landing or a retry."
      }
    },
    "primary_dimension": {
      "type": "choice",
      "instructions": "Which single review dimension should lead for this change?",
      "criteria": {
        "concurrency": "Locking, retries, leases and what happens when two writers overlap",
        "correctness": "Whether the new logic decides the right thing on the ordinary path",
        "compatibility": "Whether existing callers, tests and stored data keep working unchanged"
      }
    }
  }
}
```

Sent with `curl -sS 127.0.0.1:8765/v1/systemone -H 'content-type: application/json' -d @body.json`, the 0.8B answered:

```json
{
  "model": "jev-style-0.8b-decision-v3",
  "answers": {
    "security_review": { "type": "noul", "noul": 0.097392541637024 },
    "performance_review": { "type": "noul", "noul": 0.19449100188807264 },
    "primary_dimension": {
      "type": "choice",
      "choice": "concurrency",
      "confidence": 0.2865091122170986,
      "probabilities": {
        "concurrency": 0.5243394081447325,
        "correctness": 0.32694621367285837,
        "compatibility": 0.14871437818240918
      }
    }
  },
  "usage": { "input_tokens": 975, "state_tokens": 588, "output_tokens": 0 },
  "latency_ms": 619.4,
  "timing": { "total_ms": 619.4 },
  "backend": "mlx"
}
```

and the 2B v4, same body, on `:8766`:

```json
{
  "model": "jev-style-2b-decision-v4",
  "answers": {
    "security_review": { "type": "noul", "noul": 0.09590824030695376 },
    "performance_review": { "type": "noul", "noul": 0.07309138872938582 },
    "primary_dimension": {
      "type": "choice",
      "choice": "concurrency",
      "confidence": 0.6342775203636788,
      "probabilities": {
        "concurrency": 0.7561850135757859,
        "correctness": 0.1875812401030541,
        "compatibility": 0.05623374632115994
      }
    }
  },
  "usage": { "input_tokens": 816, "state_tokens": 588, "output_tokens": 0 },
  "latency_ms": 260.6,
  "timing": { "total_ms": 260.6 },
  "backend": "mlx"
}
```

Answer shape per question type:

| `question.type` | Answer object                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noul`          | `{"type": "noul", "noul": <P(true)>}` — a probability in 0..1, no confidence and no threshold of its own                                                        |
| `choice`        | `{"type": "choice", "choice": <option>, "confidence": <0..1>, "probabilities": {<option>: <p>, ...}}`, 1 to 255 options, `confidence = (k·p_max − 1) / (k − 1)` |
| `score`         | `{"type": "score", "score": <expected level index>, "legend": [...], "probabilities": {...}, "confidence": <0..1>}`, 2 to 10 levels                             |

Top-level fields a client can rely on: `model` (the served release), `answers` keyed by question id, `usage`
(`input_tokens`, `state_tokens`, `output_tokens` — always 0, the model does not generate text), `latency_ms`,
`timing.total_ms`, and `backend`. The answers are deterministic: three identical requests to each port returned a
byte-identical `answers` object (same sha256 over the sorted JSON), so a client can compare probabilities directly.
`latency_ms` and `timing` change from call to call. The choice answers above are the same option on both releases; the
confidence is not — 0.29 for the 0.8B, 0.63 for the 2B v4, which is the whole reason to consider the larger one.

Error behaviour, each checked against `:8765` with a real request:

| Request                                 | Status | Body                                                                                                                                                                                                             |
| --------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| body is not JSON                        |    422 | `{"error":{"code":"invalid_json","message":"request body is not valid JSON: Expecting value: line 1 column 29 (char 28)"}}`                                                                                      |
| no `questions`                          |    422 | `{"error":{"code":"invalid_request","message":"questions must be an object mapping id -> question"}}`                                                                                                            |
| `questions` empty                       |    422 | `{"error":{"code":"invalid_request","message":"questions must not be empty"}}`                                                                                                                                   |
| unknown question type (`box`)           |    400 | `{"error":{"code":"unsupported_question_type","message":"box questions are not supported by the Jev-Style models (no box readout)","question":"q"}}`                                                             |
| `choice` with 0 options                 |    422 | `{"error":{"code":"invalid_question","message":"choice needs 1..255 options (got 0)","question":"q"}}`                                                                                                           |
| 152,500-byte state (32,568 tokens)      |    400 | `{"error":{"code":"max_tokens_exceeded","message":"input needs 32568 tokens (state 32505 + head 63); the limit is 25600 (model maximum 25600). Nothing was truncated: shorten the state. (nothing truncated)"}}` |
| `GET /v1/systemone` or an unknown route |    404 | `{"error":{"code":"not_found","message":"Not Found"}}`                                                                                                                                                           |

So the shape is always `{"error": {"code", "message", "question"?}}`, `question` naming the offending id when there
is one, and a malformed request never comes back as a 200 with an empty answer. Over-long input is refused, never
truncated.

## 5. Limits

- **Loopback only.** Both servers bind 127.0.0.1; that bind is the whole access control, because 0.6.3 checks neither
  the `Host` header nor the `Origin` (section 4). Nothing here is reachable from the network, and no API key is set.
- **One model per process.** Two releases mean two processes, two ports and two copies of the runtime; one port cannot
  serve both.
- **Context budget, as upstream states it**: 25,600 tokens for the 0.8B v3 (`--release 0.8b`, the default), 32,768
  tokens for the 2B v4 (`--release 2b`, images included on the PyTorch build only). The MLX builds read text only. On
  the 0.8B a single question with its options is additionally capped at 2,048 tokens. Over-budget input is rejected
  with `400 max_tokens_exceeded`, not truncated.
- **Speed is hundreds of milliseconds, not tens.** Upstream's own README says about 0.15 to 0.2 s for a short request
  to the 0.8B on an M1 Max; the 2.7 KB state used here costs 247 to 593 ms per request depending on the release. That
  is fine for a decision made once per code change and too slow for anything per token.
- **The 0.8B is not simply the cheap version of the 2B here.** On this machine, its warm latency depends on the input
  much more than the 2B's: for the 2.7 KB body the 0.8B took 576 ms median against 247 ms for the 2B v4, while for a
  150-byte state it was the faster one (43 vs 53 ms, five requests each). It was also less confident on the choice
  question (0.29 vs 0.63). Measure both on your own inputs before choosing.
- **Weights are Apache-2.0** (fine-tunes of Qwen3.5-0.8B/2B; each model repo carries its NOTICE). The package code is
  Apache-2.0 too. Local inference needs no API key and sends nothing off the machine.
- **Calibration is a fitted temperature, not an accuracy guarantee**, and these are small models: 64.1 % (0.8B v3) and
  74.9 % (2B v4, self-run) on upstream's JevBench. Treat a probability as a routing signal to threshold, and measure
  agreement on this project's own changes before trusting it with a decision that has consequences.
