# Live tutorial evals

These are paid, real-model evaluations of the browser tutorial. They are deliberately separate from `npm test` and `npm run check`.

## Run

Build the trusted engine once, choose a judge model, then select a scope:

```sh
export EVAL_JUDGE_MODEL='provider/model-name'
npm run eval -- --scenario learner-led-happy-path
npm run eval -- --lesson 002
npm run eval -- --all --yes
npm run eval -- --scenario learner-led-happy-path --repeat 3
npm run eval -- --calibrate
```

A scope is mandatory. The lesson-001 matrix is six tutor sessions and six judge calls: roughly 120,000 total model tokens and 10–30 minutes when sequential. `--all` requires `--yes` in an interactive terminal. The tutor uses the ordinary tutorial Pi configuration; only the judge model is selected by `EVAL_JUDGE_MODEL`. Set `EVAL_JUDGE_COMMAND` only when the judge is invoked through a compatible Pi wrapper (default: `pi --no-session`).

## What it exercises

The runner copies the tutorial into a temporary learner workspace, starts the checked-out engine on an ephemeral port, consumes `/api/events` as SSE, and posts the same shared browser protocol messages as the web client. It maps choice labels to per-session option IDs; it never parses prose for a choice. Successful workspaces are removed. Failed workspaces and all reports are retained.

The engine's file tools enforce the workspace boundary after resolving symlinks and emit sanitised `audit` events. This is a tool boundary, not an operating-system sandbox.

`factory-stubs.ts` performs `bash -n` and runs `factory/run.sh` on a controlled `PATH`. Its `pi` stub captures stdin, arguments, working directory, reviewer output, saved reports, and the Enter pause, so factory checks do not spend another model call.

## Results

Ignored output is under `evals/reports/<run-id>/`: raw events and browser messages, snapshots, readable transcript, deterministic gate, stub result, judge JSON with verified event citations, metadata, and summary. A run passes only when its deterministic gate passes and every applicable judge score is non-zero with at least 80% total. Happy paths omit mistake diagnosis (7/8); mistake scenarios require 8/10.

Only provider 429/5xx, connection resets, and a timeout before useful output qualify for one fresh-workspace retry. Tutor protocol/artifact failures and judge failures never retry. With `--repeat 3`, two passing runs and a median score of 80% are required.

## Authoring scenarios and calibrating the judge

Scenario data lives in `scenarios/lesson-*/scenarios.ts` and has canonical atomic patches, learner messages, preconditions, and expected states. Keep the learner deterministic; it is not a second model. Add hand-reviewed JSON packets to `judge-calibration/` before changing the judge prompt or model, then run `npm run eval -- --calibrate` to verify that good packets stay passing and bad packets stay failing in regression review.
