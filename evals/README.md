# Live tutorial evals

These are paid, real-model evaluations of the browser tutorial. They are deliberately separate from `npm test` and `npm run check`.

## Run

Build the trusted engine once, choose a judge model, then select a scope:

```sh
export EVAL_JUDGE_MODEL='provider/model-name'
npm run eval -- --scenario doer-learner-led-happy-path
npm run eval -- --lesson 005
npm run eval -- --all --yes
npm run eval -- --scenario doer-learner-led-happy-path --repeat 3
npm run eval -- --calibrate
```

A scope is mandatory. The largest matrices, lessons 002, 005 and 007, are six or seven tutor sessions and as many judge calls each: roughly 120,000 total model tokens and 10–30 minutes when sequential. Part 2 is nine lessons, so `--all` is now well over twice what it used to cost — scope to a lesson unless you mean it. Lessons 001, 004 and 013 build no artefact, so their scenarios are graded by the judge alone. `--all` requires `--yes` in an interactive terminal. The tutor uses the ordinary tutorial Pi configuration; only the judge model is selected by `EVAL_JUDGE_MODEL`. Set `EVAL_JUDGE_COMMAND` only when the judge is invoked through a compatible Pi wrapper (default: `pi --no-session`).

`evals/tsconfig.json` typechecks this directory under `--strict`. The harness runs under `tsx`, which strips types without checking them, so `npm run check` runs `npm run check:eval` to keep a wrong annotation here from being invisible.

## What it exercises

The runner copies the tutorial into a temporary learner workspace, starts the checked-out engine on an ephemeral port, consumes `/api/events` as SSE, and posts the same shared browser protocol messages as the web client. It maps choice labels to per-session option IDs; it never parses prose for a choice. Successful workspaces are removed. Failed workspaces and all reports are retained.

The engine's file tools enforce the workspace boundary after resolving symlinks and emit sanitised `audit` events. This is a tool boundary, not an operating-system sandbox.

`factory-stubs.ts` performs `bash -n` and runs the script the active lesson asks for — `factory/refactor-do.sh`, `factory/refactor-validate.sh`, `factory/refactor/run.sh`, or from lesson 010 one of the operating scripts beside the line — on a controlled `PATH`. One stub program stands in for `pi`, `npm` and `git`, capturing stdin, arguments, working directory, validator output, saved reports, and the Enter pause, so factory checks do not spend another model call.

The stub follows Pi's `--mode`. In `json` it emits the subset of the event stream the lessons read back, which is what lets the gate prove lesson 009's round trip — JSON out of a station, text back into the branch. In `rpc` it reads JSONL commands from the fifo lesson 012 builds and answers the first `prompt`, which is what caught a canonical script whose `jq` pretty-printed its command across eight lines.

Scripts run in their own process group and are signalled as one. From lesson 010 a script leaves children of its own — a `tail -f` in a pipeline, a model process and a `sleep` holding a fifo — and signalling only Bash leaves them holding the pipe the harness reads, so the run hangs rather than ending.

The harness needs `jq` on the `PATH` as well as Bash: the lessons use it from 009 onwards, and the canonical scripts are run rather than only matched.

## Results

Ignored output is under `evals/reports/<run-id>/`: raw events and browser messages, snapshots, readable transcript, deterministic gate, stub result, judge JSON with verified event citations, metadata, and summary. A run passes only when its deterministic gate passes and every applicable judge score is non-zero with at least 80% total. Happy paths omit mistake diagnosis (7/8); mistake scenarios require 8/10.

Only provider 429/5xx, connection resets, and a timeout before useful output qualify for one fresh-workspace retry. Tutor protocol/artifact failures and judge failures never retry. With `--repeat 3`, two passing runs and a median score of 80% are required.

## Authoring scenarios and calibrating the judge

Scenario data lives in `scenarios/lesson-*/scenarios.ts` and has canonical atomic patches, learner messages, preconditions, and expected states. Keep the learner deterministic; it is not a second model. Add hand-reviewed JSON packets to `judge-calibration/` before changing the judge prompt or model, then run `npm run eval -- --calibrate` to verify that good packets stay passing and bad packets stay failing in regression review.
