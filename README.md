# Software factory tutorial developer workspace

This repository contains the learner workbook and the local engine that runs it. The authored
tutorial template lives under [`tutorial/`](tutorial/). Each launch creates or reopens private live
learner workspaces under `tutorial/.tutorial/<session-id>/workspaces/<workspace-id>/`.

## Architecture map

- [`tutorial/`](tutorial/) holds learner-facing workbook content, lessons, specs, seed files, and
  authored starter trees.
- [`tutorial-engine/`](tutorial-engine/) is the browser-led workbook engine and its tests.
- [`tutorial-engine/evals/`](tutorial-engine/evals/) owns synthetic engine-mechanics live evals,
  engine-v2 report markers, deterministic evaluator checks, and active reports under
  `tutorial-engine/evals/reports/`.
- [`evals/`](evals/) owns the evaluation map, authored-workbook evaluator foundations, and live
  authored-workbook reports under `evals/workbook/reports/`.
- [`scripts/`](scripts/) contains root launchers and setup helpers.

## Root commands

Run these from the repository root:

```sh
npm install
npm run setup
npm run tutorial:workbook
npm start
npm run tutorial:workbook -- --session <id>
npm run --workspace=tutorial-engine check:workbook

npm run test:fast
npm run test:engine:fast
npm run test:workbook:fast
npm run test

npm run eval:engine -- --help
npm run eval -- --help
npm run eval:release
npm run eval:workbook -- --list
npm run eval:workbook -- --release
```

See [`docs/testing.md`](docs/testing.md) for the authoritative testing workflow, command matrix,
live-eval prerequisites, report privacy rules, visual approval process, and `test:fast`
benchmark notes. In short: `test:fast` is the normal deterministic gate; `check` remains a
compatibility alias for it; `test` is the paid/Docker-backed release gate; `eval:workbook -- --list`
has zero side effects.
`npm run eval -- ...` is a temporary compatibility alias for `eval:engine`, not an authored eval.
`eval:workbook` is the authored-curriculum live runner.

`npm run tutorial:workbook` supplies the embedded terminal with one read-only runtime mount: root
`node_modules/` at the active live workspace's `node_modules/`. A normal launch creates a new
session and copies each declared workspace template; `--session <id>` reopens an existing workbook
session. Current-format workbook event and attempt records reconstruct that session; missing or
unsupported event-log formats fail with an instruction to start fresh. The removed browser tutor's
ignored state is neither resumed nor migrated.

## Evaluation ownership

Use [`evals/README.md`](evals/README.md) as the active ownership map and
[`docs/testing.md`](docs/testing.md) as the command workflow. The short version is:

- [`tutorial-engine/evals/`](tutorial-engine/evals/) is tutorial-engine-owned and evaluates
  synthetic engine mechanics.
- [`evals/workbook/`](evals/workbook/) is root-owned and evaluates real authored-curriculum slices.
- `evals/reports/` is historical compatibility only. No active runner writes there.

Live report files are ignored and split into public curated files and private diagnostics. Do not
publish raw events, gate diagnostics, cleanup failures, prompts, credentials, or disposable paths.

## Start points

- Learners: start with [`tutorial/README.md`](tutorial/README.md), then run
  `npm run tutorial:workbook`.
- Engine developers: start with [`tutorial-engine/README.md`](tutorial-engine/README.md) and its
  ADRs. Synthetic engine-mechanics evals live under
  [`tutorial-engine/evals/`](tutorial-engine/evals/).
- Curriculum maintainers: edit authored lesson prose under [`tutorial/lessons/`](tutorial/lessons/)
  and canonical lesson specs under [`tutorial/docs/specs/`](tutorial/docs/specs/). Authored-workbook
  eval foundations live under [`evals/workbook/`](evals/workbook/).
- Coding agents: read [`AGENTS.md`](AGENTS.md).
