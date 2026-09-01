# Testing workflow

This is the authoritative maintainer workflow for local checks, visual approval, and live evals.
Run commands from the repository root unless a command says otherwise.

## Command matrix

| Command | Owner | Kind |
| --- | --- | --- |
| `npm run check` | root | Alias for deterministic `test:fast`. |
| `npm run test:fast` | root | Full fast gate; deterministic, model-free, Docker-free. |
| `npm run test:engine:fast` | root -> engine | Engine fast lane; deterministic. |
| `npm run test:workbook:fast` | root | Workbook fast lane; deterministic. |
| `npm run test:engine` | root -> engine | Engine component release; paid/Docker. |
| `npm run test:workbook` | root | Workbook component release; paid/Docker. |
| `npm run test` | root | Full release; paid/Docker; aggregates lanes. |
| `npm run eval:engine -- ...` | root -> engine | Live engine eval; paid/Docker. |
| `npm run eval:release` | root -> engine | Engine release; two consolidated scenarios once. |
| `npm run eval:workbook -- --list` | root | Authored catalog; zero side effect. |
| `npm run eval:workbook -- --release` | root | Authored release; four once, budget derived. |

Fast lanes include engine mechanics, workbook content, authored-workbook evaluator foundations,
onboarding, and calculator tests as described in the focused commands below.

`test:fast` is the normal local gate. Keep it deterministic, model-free, and Docker-free. Do not add
Tutor, Judge, Docker, visual, or live-eval calls to it.

`npm run test` is not a shell `&&` chain. The orchestrator runs all four independent release lanes,
continues after ordinary failures, and prints a summary for every lane. It reports `latest.json` or
received screenshots only when the current lane changed those files during this run.

## Canonical commands

### Local loop

```sh
npm install
npm run setup
npm run test:fast
```

`npm run check` remains supported as a compatibility alias for the same deterministic fast gate;
do not run both back-to-back.

### Focused deterministic lanes

```sh
npm run test:engine:fast
npm run test:workbook:fast
npm run check:eval:workbook
npm run test:eval:workbook
npm run --workspace=tutorial-engine check:eval
npm run --workspace=tutorial-engine test:eval
npm run --workspace=tutorial-engine check:workbook
```

### Full component release lanes

Use these only when you intend to run paid/Docker-backed live evals:

```sh
export OPENCODE_API_KEY='...'
export TUTOR_MODEL='provider/model'
export EVAL_JUDGE_MODEL='provider/model'
export EVAL_JUDGE_COMMAND='pi --no-session'

npm run test:engine
npm run test:workbook
```

### Full release gate

```sh
export OPENCODE_API_KEY='...'
export TUTOR_MODEL='provider/model'
export EVAL_JUDGE_MODEL='provider/model'
export EVAL_JUDGE_COMMAND='pi --no-session'

npm run test
```

### Visual approval

Visual validation is canonical only in the repository devcontainer. From the host, the wrapper
brings up the canonical devcontainer and runs the visual command there:

```sh
npm run check:visual
```

A visual approval is a deliberate second step. Inspect the changed `.received.png` files, then
approve inside the canonical devcontainer only:

```sh
npm run approve:visual
```

The approval script refuses to run outside the canonical devcontainer.

## Live eval prerequisites

Live engine and authored-workbook evals require generic Linux Docker plus the canonical terminal
image, not the visual devcontainer. Before a live run:

1. Install dependencies with `npm install`.
2. Build the terminal image:
   `npm run --workspace=tutorial-engine build:workbook-terminal`.
3. Start Docker and make the daemon reachable from this shell.
4. Export `OPENCODE_API_KEY` for the workbook terminal auth path.
5. Authenticate Pi on the host for the Main Tutor provider and, for judged selections, the Judge provider.
6. Set explicit models, either by flags where supported or by environment:
   `TUTOR_MODEL` and, for judged selections, `EVAL_JUDGE_MODEL`.
7. Set `EVAL_JUDGE_COMMAND` explicitly for judged selections, for example `pi --no-session` or a Pi-compatible wrapper.

Paid calls can occur in two roles: Main Tutor and Judge. Judge calls are scenario-specific; Lessons 003–004 has zero Judge calls and passes or fails solely by its deterministic 17-assertion gate. Deterministic gates do not call either role.

Run engine live evals with a scenario, all confirmed scenarios, or the release profile:

```sh
npm run eval:engine -- --scenario v2-exact-command-success
npm run eval:engine -- --all --yes
npm run eval:engine -- --release
npm run eval:release
```

The engine release profile runs `v2-editor-feedback-locked` and `v2-transition-completion` exactly once each; use `--all --yes` for all current engine scenarios.

Run authored-workbook live evals with a scenario, all confirmed scenarios, or the release profile:

```sh
npm run eval:workbook -- --list
npm run eval:workbook -- --scenario lesson-001-headless-boundary \
  --max-paid-model-calls 20 --max-estimated-tokens 40000
npm run eval:workbook -- --all --yes \
  --max-paid-model-calls 86 --max-estimated-tokens 172000
npm run eval:workbook -- --release
```

`--list` has no side effects. Authored exploratory scenario and all-scopes require explicit bounded
budgets. Bare authored `--release` derives the fixed catalog budget and runs the four authored
scenarios once in order.

## Authored-workbook eval distinction

The authored-workbook runner evaluates real learner-curriculum slices. It is not the synthetic
engine-mechanics suite under `tutorial-engine/evals/`.

The four authored release scenarios are:

- `primer-validation-misconception`
- `lesson-001-headless-boundary`
- `lessons-003-004-evidence-feedback`
- `lesson-013-operator-judgement`

Lesson 001 uses the real headless Pi boundary. Its scenario runs the authored terminal commands and
checks that the learner explains the job, harness, exit behaviour, and read-only tool boundary. It
must not use command stubs.

All authored live scenarios still use the real Main Tutor review path. Post-L001 scenarios use
driver-private command stubs only for selected authored learner shell commands. The
stubs live only inside disposable session workspaces and strip their activation prefix from recorded
state, transcripts, traces, prompts, reports, and latest metadata. This keeps the slice honest about
the curriculum while avoiding unbounded recursive Pi/npm shell work.

The slices are deliberately honest rather than comprehensive: a primer misconception, a real L001
headless boundary, a Lessons 003-004 evidence-feedback path, and a Lesson 013 operator-judgement
path. Each slice declares prerequisite seeds, expected artifacts, deterministic gates, closed Judge policy, expected model calls, cost budget derivation, and public criteria. Primer, Lesson 001, and Lesson 013 retain one Judge call; Lessons 003–004 declares zero Judge calls and uses its 17 gate assertions as the deterministic-only success verdict.

## Reports and privacy

Engine reports are engine-owned and marked with `tutorial-engine/evals/engine-v2`. Current engine
live reports are ignored under `tutorial-engine/evals/reports/`, with `latest.json` in that tree.

Authored-workbook reports are root-owned and marked with `root/workbook`. Current authored reports
are ignored under `evals/workbook/reports/`, with `latest.json` in that tree.

Public curated report files may include `trace.json`, `artifacts.json`, `judge-input.txt` or
`judge-input.json`, `judge.json`, `report.json`, `summary.md`, `metadata.json`, and `latest.json`.
Use only the exact files listed by current-run metadata or latest summaries. Authored run directories are closed: only the advertised curated files plus recognized local diagnostics (`gate.json`, `failure.txt`, `cleanup-failure.txt`) are valid. Deterministic-only authored success omits `judge-input.json` and `judge.json`, reports `evaluationMode: deterministic-only`, and uses the `deterministic-gate-only` verdict rule without a percentage.

Raw events, gate assertions, failure diagnostics, cleanup diagnostics, prompts, responses, server
URLs, absolute disposable paths, and credentials are private. Files such as `gate.json`,
`failure.txt`, and `cleanup-failure.txt` are local diagnostics. Do not publish them blindly or paste
them into public summaries.

Live workspaces are normally deleted. `--keep-workspace` is allowed only for one authored
non-release `--scenario` run at repeat 1. It is private debug output; do not copy the absolute path
into reports, latest metadata, issues, or reviews.

## Failure and preflight rules

Live preflight spends unpaid setup checks before paid calls. Argument validation, budget validation,
Docker CLI/daemon access, image inspection, disposable terminal startup, in-container Pi auth,
fixture validation, and privacy checks happen before role probes can spend tokens. Main Tutor is always preflighted; Judge is preflighted only when at least one selected authored scenario requires a Judge call.

If preflight fails, the live runner must not create or mutate the report root, `latest.json`, live
workspaces, sessions, stubs, or judge inputs. A stale report is not evidence of the failed run. If an abort is observed during mandatory cleanup, the runner may write only honest interrupted failure metadata for the attempted run and must not publish a success bundle or update `latest.json` after the abort.

During `npm run test`, independent lanes continue after ordinary failures. The final exit code is
non-zero if any lane fails. The summary reports only current-run changed reports: changed engine or
workbook `latest.json`, and changed visual `.received.png` screenshots.

Visual failures report received screenshots. Inspect them before deciding whether to fix the code,
fix the authored UI, or approve the new baseline in the canonical devcontainer.

## Benchmark: `npm run test:fast`

Observed on 2026-08-30 in this isolated worktree at `0168db3`, after `npm install`.

Host context: macOS 26.6.2 on Darwin arm64 (`MattBook-Air.localdomain`), Node v24.14.1, npm 11.11.0.
This is a noncanonical host run, not the Linux devcontainer.

Exact timed command: `/usr/bin/time -p npm run test:fast`.

| Run | Preparation | Result | Wall time |
| --- | --- | --- | --- |
| Cold | Removed generated `tutorial-engine/dist` before the run. | Pass | 128.57 s |
| Warm 1 | Reused generated outputs and dependency cache. | Pass | 111.03 s |
| Warm 2 | Reused generated outputs and dependency cache. | Pass | 109.33 s |

Observed warm range: 109.33-111.03 s. The measurement includes engine fast checks, authored-workbook
fast checks, workbook content checks, web build, browser smoke, and calculator tests. It is a local
host observation, not a service-level promise.

Full paid/Docker release timing is unavailable for this host context. The known external blocker is
that the Docker daemon preflight times out before any paid calls; no current-run live report is
produced in that case.
