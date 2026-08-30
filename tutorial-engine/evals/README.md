# Synthetic tutorial-engine mechanics evals

These evaluations drive the dedicated synthetic evaluation workbook through the real tutorial-engine HTTP and terminal WebSocket protocol. They make paid, real-model calls and are deliberately separate from deterministic tests. They exercise tutorial-engine mechanics, not the root-owned authored-workbook eval suite for the learner curriculum. See [`../../evals/README.md`](../../evals/README.md) for the cross-repository ownership map.

## Prerequisites

Before running a live eval:

1. Install dependencies from the repository root: `npm install`.
2. Build the embedded terminal image: `npm run --workspace=tutorial-engine build:workbook-terminal`.
3. Start Docker. The workbook terminal preflight requires bounded `docker info`, image inspect, container start, in-container Pi authentication, and cleanup commands to succeed for the `lean-software-production/workbook-terminal:latest` image.
4. Export `OPENCODE_API_KEY`. The embedded terminal passes this key into `docker run` through a minimal Docker-client child environment and uses `--env OPENCODE_API_KEY`; it must not appear in Docker argv or error text. The Docker child environment is limited to `PATH`, `HOME`, documented Docker client configuration variables, XDG config/runtime variables, and this key; arbitrary parent secrets and proxy variables are not forwarded.
5. Ensure Pi is authenticated on the host for the Main Tutor and Judge providers.
6. Export `EVAL_JUDGE_MODEL` as the Judge model, for example `provider/model-name`.
7. Optionally export `TUTOR_MODEL` as the Main Tutor model. If it is unset, the workbook lets Pi choose its configured default.
8. Optionally export `EVAL_JUDGE_COMMAND` for a Pi-compatible judge wrapper. The default is `pi --no-session`.

## Cost warning

`npm run --workspace=tutorial-engine eval` is the live workspace command. It spends model tokens for the Main Tutor and Judge. A single selected scenario preflights the Main Tutor and Judge, starts a fresh workbook server, drives one learner session, runs deterministic gates, and then calls the Judge once if the gates pass. `--repeat 3` can make three tutor sessions and three Judge calls. `--all --yes` runs every v2 scenario and can spend several times more. `--release` is the bounded release profile: it runs the six current engine scenarios exactly once each and rejects `--all`, `--scenario`, and `--repeat` combinations.

Do not put `npm run --workspace=tutorial-engine eval` in deterministic checks. `npm run --workspace=tutorial-engine check:eval` and `npm run --workspace=tutorial-engine test:eval` are deterministic and model-free. Root authored-workbook equivalents are `npm run check:eval:workbook` and `npm run test:eval:workbook`; they inspect root `evals/workbook/` foundations and do not call the Main Tutor or Judge. Root `npm run check` remains model-free: it typechecks and unit-tests the evaluator through the tutorial-engine workspace but does not call the Main Tutor or Judge.

## Usage

A scope is mandatory:

```sh
export OPENCODE_API_KEY='...'
export EVAL_JUDGE_MODEL='provider/model-name'
# optional: export TUTOR_MODEL='provider/model-name'
# optional: export EVAL_JUDGE_COMMAND='pi --no-session'

npm run --workspace=tutorial-engine eval -- --scenario v2-exact-command-success
npm run --workspace=tutorial-engine eval -- --scenario v2-exact-command-success --repeat 3
npm run --workspace=tutorial-engine eval -- --all --yes
npm run --workspace=tutorial-engine eval -- --release
npm run --workspace=tutorial-engine eval:release
```

From the repository root, `npm run eval:engine -- ...` forwards to the same workspace command. `npm run eval:release` delegates to the tutorial-engine release profile with `--workspace=tutorial-engine`. `npm run eval -- ...` is a temporary compatibility alias for that forwarding command, not an authored-workbook eval. The root `eval:workbook` name remains reserved and unwired until the authored-curriculum live runner lands.

The v2 live evaluator does not support the legacy `--lesson` or `--calibrate` scopes.

## Fail-fast live preflight

The runner performs setup checks before it creates `evals/reports/`, creates a live evaluation workspace, starts a workbook server, or drives any tutor/judge model session. Help output, malformed arguments, scope conflicts, and missing `--all --yes` confirmation remain entirely model-free and return before probes.

The live preflight order is fixed:

1. Parse scope and confirmation.
2. Require explicit `EVAL_JUDGE_MODEL`.
3. Copy and load the disposable evaluator fixture to prove it is readable and valid.
4. Check Docker CLI/daemon access, the canonical `lean-software-production/workbook-terminal:latest` image, a disposable container start, the same in-container Pi authentication probe used by the production workbook terminal, and bounded container cleanup.
5. Preflight the Main Tutor model identity/auth/connectivity with the same no-tools disposable Pi-session convention used by workbook startup. The provider prompt is wrapped in a local timeout and the disposable session is disposed in all cases.
6. Preflight the judge command/model with a minimal JSON connectivity check. Judge prompts and stdout are byte-bounded; judge child processes have a bounded lifetime and are killed on timeout or noisy output.

The live CLI, paid run, preflight, and metadata all read the actual `process.env`; there is no alternate run-level environment injection that could let tests pass with configuration different from the real run. Only pure config helpers and low-level preflight/probe APIs accept explicit environments. The preflight records only model identities, fixed structural judge command labels (`default-pi` or `configured-command`), and coarse capabilities such as JSON-response support or terminal container readiness. It never records credentials, prompt bodies, response bodies, raw Docker/model/judge command causes, command paths/arguments, or disposable absolute paths.

## Scenario selection

Use `--scenario <id>` to run exactly one scenario. Current scenario IDs are:

- `v2-exact-command-success`: unlocks editor practice, then runs the visible exact-command terminal practice.
- `v2-editor-feedback-locked`: submits an insufficient editor draft and expects public feedback without unlocking.
- `v2-editor-unlocked`: submits a satisfactory editor draft and expects the promoted artifact.
- `v2-clue-only-task`: unlocks editor practice, then completes the clue-only terminal practice with learner-chosen shell syntax.
- `v2-reflection-follow-up`: submits a reflection answer and a follow-up answer.
- `v2-transition-completion`: completes terminal practice, reflection, and the lesson transition.

Use `--all --yes` only when you intend to run every scenario. Use `--repeat 2` or `--repeat 3` to re-run exploratory `--scenario` or `--all` scopes in fresh workspaces; repeat must be between 1 and 3. Use `--release` for the bounded release gate; it selects the six listed scenarios once each, never repeats them, and cannot be combined with `--all`, `--scenario`, or `--repeat`.

## What it exercises

The runner copies `evals/workbook/` from the `tutorial-engine` workspace into a disposable temporary repository under `tutorial/`, materializes fresh live workspaces under `tutorial/.tutorial/<session-id>/workspaces/<workspace-id>/`, and drives the same public workbook API, editor endpoint, and terminal WebSocket used by the browser. It records public workbook state, public editor status/feedback, learner-visible terminal transcript, public reflection turns, raw `workbook/events.jsonl` rows for deterministic gates, and allowlisted session-local `factory/.tmp` plus `editor-artifacts` artifact snapshots.

Raw `workbook/events.jsonl` rows remain internal and gate-only. They may include private terminal lifecycle rows with inline terminal evidence snapshots, review request/failure IDs, summaries, timestamps, and future fields. Before anything is written to reports or sent to a judge, the runner projects the internal trace into an allowlisted public judge trace. That public trace contains learner-visible channels, artifacts, and projected structural progression events built from explicit fields only. Deterministic gates inspect the internal trace before any judge call, but judge input and reports receive only the allowlisted public judge trace plus a public gate summary with assertion counts/pass flags; raw gate assertion details stay out of `report.json` and `judge-input.txt`.

## Output ownership and schema markers

Every active v2 engine-eval envelope is marked so these synthetic tutorial-engine mechanics outputs cannot be confused with future authored-workbook evals:

```json
{
  "namespace": "tutorial-engine/evals/engine-v2",
  "owner": "tutorial-engine",
  "suite": "engine-v2",
  "schemaVersion": 1
}
```

The marker fields appear at the top level of per-run `report.json`, per-run `metadata.json`, and `evals/reports/latest.json`. Treat `schemaVersion` as the output envelope schema for these active engine eval artifacts.

## Results

Each run writes an ignored report directory under `tutorial-engine/evals/reports/<run-id>/` from the repository root (`evals/reports/<run-id>/` relative to the `tutorial-engine` workspace). The historical root `evals/reports/` path is ignored for compatibility only; no active runner writes there. Future authored-workbook live reports belong under root `evals/workbook/reports/`.

Public/curated files are safe to use as the evaluation record:

- `evals/reports/<run-id>/trace.json`: allowlisted public judge trace with public state/editor/reflection/terminal learner channels, projected structural progression events, and artifacts.
- `evals/reports/<run-id>/artifacts.json`: captured `factory/.tmp` and `editor-artifacts` artifact contents that passed the public trace projection.
- `evals/reports/<run-id>/judge-input.txt`: exact prompt sent to the judge, including scenario criteria, allowlisted public judge trace citations, and public gate counts/pass flags only.
- `evals/reports/<run-id>/judge.json`: verified judge JSON.
- `evals/reports/<run-id>/report.json`: marked combined scenario, model identities, public gate summary, allowlisted public judge trace, judge input, judge result, artifacts, and verdict. It is written only after the deterministic gate passes and the judge returns a verified result.
- `evals/reports/<run-id>/summary.md`: short human-readable result.
- `evals/reports/<run-id>/metadata.json`: marked run metadata, model identities, git revision, lifecycle status, public failure stage when applicable, report file names, and stable identifiers such as `sessionId` and workspace IDs. It intentionally does not persist disposable temporary workspace/session paths, because those paths are normally deleted during cleanup.
- `evals/reports/latest.json`: marked latest envelope with `generatedAt` and the selected scenario run results/report directories.

Local diagnostic files are not public report artifacts:

- `evals/reports/<run-id>/gate.json`: deterministic gate assertions. It is never sent to the judge and is not embedded in `report.json` or `latest.json`.
- `evals/reports/<run-id>/failure.txt`: exact failure when setup, workspace creation, server startup, the live session, deterministic gates, judge invocation, report writing, or cleanup fails, when the diagnostic file can be written. Cleanup failures include resource locations such as temporary workspace paths and server URL here, not in curated metadata. If only `metadata.json` writing fails, the returned run result and `latest.json` record the public `metadata` failure and omit `metadataFile` instead of claiming a missing per-run metadata artifact.
- `evals/reports/<run-id>/cleanup-failure.txt`: supplemental cleanup failure details when cleanup fails after an earlier failure. It can also include temporary workspace paths and server URL.

Do not publish diagnostic files blindly: they may contain internal assertion details, exact error stacks, disposable paths, server URLs, or other local debugging context. Failure metadata is still written on normal failure paths with a public failure stage and `diagnosticStatus`; if `metadata.json` itself cannot be written, the run result and `latest.json` omit `metadataFile` and report the `metadata` failure publicly. Deterministic gate failures write metadata before any judge invocation.
