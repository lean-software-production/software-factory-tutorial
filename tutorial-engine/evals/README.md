# Synthetic tutorial-engine mechanics evals

These evaluations drive the dedicated synthetic evaluation workbook through the real tutorial-engine HTTP and terminal WebSocket protocol. They make paid, real-model calls and are deliberately separate from deterministic tests. They exercise tutorial-engine mechanics, not the future authored-workbook eval suite for the learner curriculum.

## Prerequisites

Before running a live eval:

1. Install dependencies from the repository root: `npm install`.
2. Build the embedded terminal image: `npm run --workspace=tutorial-engine build:workbook-terminal`.
3. Start Docker. The workbook terminal preflight requires `docker info` to succeed and the `lean-software-production/workbook-terminal:latest` image to exist.
4. Export `OPENCODE_API_KEY`. The embedded terminal passes this key into its isolated container so Pi can authenticate there.
5. Ensure Pi is authenticated on the host for the tutor and judge providers.
6. Export `EVAL_JUDGE_MODEL` as the judge model, for example `provider/model-name`.
7. Optionally export `TUTOR_MODEL` as the tutor model. If it is unset, the workbook tutor lets Pi choose its configured default.
8. Optionally export `EVAL_JUDGE_COMMAND` for a Pi-compatible judge wrapper. The default is `pi --no-session`.

## Cost warning

`npm run --workspace=tutorial-engine eval` is the live workspace command. It spends tutor-model and judge-model tokens. A single selected scenario starts a fresh workbook server, drives one learner session, runs deterministic gates, and then calls the judge once if the gates pass. `--repeat 3` can make three tutor sessions and three judge calls. `--all --yes` runs every v2 scenario and can spend several times more.

Do not put `npm run --workspace=tutorial-engine eval` in deterministic checks. Root `npm run check` remains model-free: it typechecks and unit-tests the evaluator through the tutorial-engine workspace but does not call the tutor or judge.

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
```

From the repository root, `npm run eval:engine -- ...` forwards to the same workspace command. `npm run eval -- ...` is a temporary compatibility alias for that forwarding command.

The v2 live evaluator does not support the legacy `--lesson` or `--calibrate` scopes.

## Scenario selection

Use `--scenario <id>` to run exactly one scenario. Current scenario IDs are:

- `v2-exact-command-success`: unlocks editor practice, then runs the visible exact-command terminal practice.
- `v2-editor-feedback-locked`: submits an insufficient editor draft and expects public feedback without unlocking.
- `v2-editor-unlocked`: submits a satisfactory editor draft and expects the promoted artifact.
- `v2-clue-only-task`: unlocks editor practice, then completes the clue-only terminal practice with learner-chosen shell syntax.
- `v2-reflection-follow-up`: submits a reflection answer and a follow-up answer.
- `v2-transition-completion`: completes terminal practice, reflection, and the lesson transition.

Use `--all --yes` only when you intend to run every scenario. Use `--repeat 2` or `--repeat 3` to re-run the selected scope in fresh workspaces; repeat must be between 1 and 3.

## What it exercises

The runner copies `evals/workbook/` from the `tutorial-engine` workspace into a disposable temporary repository under `tutorial/`, materializes fresh live workspaces under `tutorial/.tutorial/<session-id>/workspaces/<workspace-id>/`, and drives the same public workbook API, editor endpoint, and terminal WebSocket used by the browser. It records public workbook state, public editor status/feedback, learner-visible terminal transcript, public reflection turns, durable workbook timeline records from `workbook/events.jsonl`, and allowlisted session-local `factory/.tmp` plus `editor-artifacts` artifact snapshots.

Timeline records are durable evaluator inputs and may include internal terminal lifecycle records; do not read them as all learner-visible events. The recorder refuses to store a private `tutor` field or known private tutor-guidance sentinel text. Deterministic gates inspect the trace before any judge call. The judge receives the scenario criteria and this checked trace, not the authored curriculum or private tutor guidance.

## Results

Each run writes an ignored report directory under `evals/reports/<run-id>/` relative to the `tutorial-engine` workspace. Important files are:

- `evals/reports/<run-id>/trace.json`: public state/editor/reflection/terminal learner trace, durable workbook timeline records, and artifacts.
- `evals/reports/<run-id>/gate.json`: deterministic gate assertions.
- `evals/reports/<run-id>/artifacts.json`: captured `factory/.tmp` and `editor-artifacts` artifact contents.
- `evals/reports/<run-id>/judge-input.txt`: exact prompt sent to the judge, including scenario criteria and checked trace citations.
- `evals/reports/<run-id>/judge.json`: verified judge JSON.
- `evals/reports/<run-id>/report.json`: combined scenario, model identities, gate, trace, judge input, judge result, artifacts, and verdict.
- `evals/reports/<run-id>/summary.md`: short human-readable result.
- `evals/reports/<run-id>/metadata.json`: run metadata, model identities, git revision, and workspace paths.
- `evals/reports/<run-id>/failure.txt`: exact failure when setup, the live session, deterministic gates, or judge invocation fails.

The latest command also writes `evals/reports/latest.json` with the selected scenarios and report directories.
