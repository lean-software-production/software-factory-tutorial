# Testing workflow

This is the authoritative maintainer workflow for local checks, visual approval, and live engine evals.
Run commands from the repository root unless a command says otherwise.

## Command matrix

| Command | Owner | Kind |
| --- | --- | --- |
| `npm run check` | root | Alias for deterministic `test:fast`. |
| `npm run test:fast` | root | Fast gate: engine fast lane plus workbook fast lane; deterministic, model-free, Docker-free. |
| `npm run test:engine:fast` | root -> engine | Engine fast lane; deterministic. |
| `npm run test:workbook:fast` | root | Root onboarding/infrastructure plus generic workbook load/schema check; deterministic. |
| `npm run check:workbook` | root -> engine | Runs the generic engine workbook checker against `tutorial/` via an explicit `../tutorial` argument. |
| `npm run test:engine` | root -> engine | Engine component release; paid/Docker because it includes the live synthetic engine eval. |
| `npm run test` | root | Full release; paid/Docker; aggregates deterministic fast, visual, and live synthetic engine eval lanes. |
| `npm run eval:engine -- ...` | root -> engine | Live synthetic engine eval; paid/Docker. |
| `npm run eval:release` | root -> engine | Engine release profile. |

`tutorial/` is manually authored content, not code. Deterministic tests, checkers, and evals must not
pin its prose, seed bytes, IDs, ordering, counts, block names/types/order, filenames, vocabulary,
commands, or lesson-specific learner behavior. `check:workbook` only verifies that the generic
engine loader can load the workbook and that its schema-level structure is valid. Prose, lesson
quality, and learning outcomes remain author-owned.

Occasional human or dynamic agent play-throughs are useful observations, but they must consume the
workbook dynamically and remain non-gating. Do not add them to `check`, `test:fast`, or release
orchestration.

`npm run test` is not a shell `&&` chain. The orchestrator runs independent release lanes, continues
after ordinary failures, and prints a summary for every lane. It reports `latest.json` or received
screenshots only when the current lane changed those files during this run.

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
npm run check:workbook
npm run --workspace=tutorial-engine check:eval
npm run --workspace=tutorial-engine test:eval
```

Do not run the calculator learner-workspace tests as a repository gate. They belong to the authored
learner workspace and may be exercised within tutorial sessions, not as root release wiring.

### Full component release lane

Use this only when you intend to run paid/Docker-backed live engine evals:

```sh
export OPENCODE_API_KEY='...'
export TUTOR_MODEL='provider/model'
export EVAL_JUDGE_MODEL='provider/model'
export EVAL_JUDGE_COMMAND='pi --no-session'

npm run test:engine
```

### Full release gate

```sh
export OPENCODE_API_KEY='...'
export TUTOR_MODEL='provider/model'
export EVAL_JUDGE_MODEL='provider/model'
export EVAL_JUDGE_COMMAND='pi --no-session'

npm run test
```

Full release currently aggregates:

1. `npm run test:fast`
2. `npm run --workspace=tutorial-engine test:visual`
3. `npm run eval:engine -- --release`

It does not run an authored-workbook eval/report lane.

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

Live engine evals require generic Linux Docker plus the canonical terminal image, not the visual
devcontainer. Before a live run:

1. Install dependencies with `npm install`.
2. Build the terminal image: `npm run --workspace=tutorial-engine build:workbook-terminal`.
3. Start Docker and make the daemon reachable from this shell.
4. Export `OPENCODE_API_KEY` for the workbook terminal auth path.
5. Authenticate Pi on the host for the tutor and judge providers used by the engine eval.
6. Set explicit models, either by flags where supported or by environment: `TUTOR_MODEL` and
   `EVAL_JUDGE_MODEL`.
7. Set `EVAL_JUDGE_COMMAND` explicitly, for example `pi --no-session` or a Pi-compatible wrapper.

Run engine live evals with a scenario, all confirmed scenarios, or the release profile:

```sh
npm run eval:engine -- --scenario v2-exact-command-success
npm run eval:engine -- --all --yes
npm run eval:engine -- --release
npm run eval:release
```

The engine release profile and scenario catalog are documented in
[`../tutorial-engine/evals/README.md`](../tutorial-engine/evals/README.md).

## Reports and privacy

Engine reports are engine-owned and marked with `tutorial-engine/evals/engine-v2`. Current engine
live reports are ignored under `tutorial-engine/evals/reports/`, with `latest.json` in that tree.

Public curated report files may include `trace.json`, `artifacts.json`, `judge-input.txt`,
`judge.json`, `report.json`, `summary.md`, `metadata.json`, and `latest.json`. Use only the exact
files listed by current-run metadata or latest summaries.

Raw events, gate assertions, failure diagnostics, cleanup diagnostics, prompts, responses, server
URLs, absolute disposable paths, and credentials are private. Files such as `gate.json`,
`failure.txt`, and `cleanup-failure.txt` are local diagnostics. Do not publish them blindly or paste
them into public summaries.

## Failure and preflight rules

Live preflight spends unpaid setup checks before paid calls. Argument validation, budget validation,
Docker CLI/daemon access, image inspection, disposable terminal startup, in-container Pi auth,
fixture validation, and privacy checks happen before role probes can spend tokens.

If preflight fails, the live runner must not create or mutate the report root, `latest.json`, live
workspaces, sessions, or judge inputs. A stale report is not evidence of the failed run. If an abort
is observed during mandatory cleanup, the runner may write only honest interrupted failure metadata
for the attempted run and must not publish a success bundle or update `latest.json` after the abort.

During `npm run test`, independent lanes continue after ordinary failures. The final exit code is
non-zero if any lane fails. The summary reports only current-run changed reports: changed engine
`latest.json`, and changed visual `.received.png` screenshots.

Visual failures report received screenshots. Inspect them before deciding whether to fix engine code,
fix workbook UI rendering, or approve the new baseline in the canonical devcontainer.
