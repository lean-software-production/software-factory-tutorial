# Software factory tutorial developer workspace

This repository contains the learner workbook and the local engine that runs it. The authored tutorial
template lives under [`tutorial/`](tutorial/). Each launch creates or reopens private live learner
workspaces under `tutorial/.tutorial/<session-id>/workspaces/<workspace-id>/`.

## Architecture map

| Path | Purpose |
| --- | --- |
| [`tutorial/`](tutorial/) | Learner-facing workbook, lessons, specs, seed files, and authored starter trees. |
| [`tutorial-engine/`](tutorial-engine/) | The browser-led workbook engine and its tests. |
| [`tutorial-engine/evals/`](tutorial-engine/evals/) | Tutorial-engine-owned synthetic engine-mechanics live evals, engine-v2 report markers, deterministic evaluator checks, and active reports under `tutorial-engine/evals/reports/`. |
| [`evals/`](evals/) | Root-owned evaluation map and authored-workbook evaluator foundations. Current workbook eval commands are deterministic; the future live runner will report under `evals/workbook/reports/`. |
| [`scripts/`](scripts/) | Root launchers and setup helpers. |

## Root commands

Run these from the repository root:

```sh
npm install
npm run setup
npm run tutorial:workbook
npm start                         # alias for tutorial:workbook
npm run tutorial:workbook -- --session <id>
npm run --workspace=tutorial-engine check:workbook
npm run check
npm run check:eval:workbook        # deterministic authored-workbook evaluator foundation type-check
npm run test:eval:workbook         # deterministic authored-workbook evaluator foundation tests
npm run --workspace=tutorial-engine check:eval  # deterministic synthetic engine evaluator type-check
npm run --workspace=tutorial-engine test:eval   # deterministic synthetic engine evaluator tests
npm run eval:engine -- --help      # live synthetic engine eval CLI, forwarded to tutorial-engine
npm run eval:release               # bounded six-scenario engine eval release profile
npm run eval -- --help             # temporary compatibility alias for eval:engine, not authored eval
```

`eval:workbook` is reserved for the future authored-curriculum live runner and is intentionally not
wired in `package.json` yet. The current authored-workbook eval commands are `check:eval:workbook`
and `test:eval:workbook`; both are deterministic and model-free.

`npm run tutorial:workbook` supplies the embedded terminal with one read-only runtime mount: root
`node_modules/` at the active live workspace's `node_modules/`. A normal launch creates a new
session and copies each declared workspace template; `--session <id>` reopens an existing workbook
session. Earlier workbook event and attempt records remain readable. The removed browser tutor's
ignored state is neither resumed nor migrated.

## Evaluation ownership

Use [`evals/README.md`](evals/README.md) as the active ownership map.

- [`tutorial-engine/evals/`](tutorial-engine/evals/) is tutorial-engine-owned. Its live suite uses
  engine-v2 markers, writes active reports under `tutorial-engine/evals/reports/`, and exercises
  synthetic engine mechanics. `npm run eval:engine -- ...` and `npm run eval:release` forward here.
  The live run is paid and Docker-backed; the package `check:eval` and `test:eval` scripts are
  deterministic and model-free.
- [`evals/workbook/`](evals/workbook/) is root-owned. It holds real authored-curriculum evaluator
  foundations and the future live authored-workbook runner. Its current deterministic commands are
  `check:eval:workbook` and `test:eval:workbook`. Future reports belong under
  `evals/workbook/reports/` and should carry workbook-owned markers.
- `evals/reports/` is historical compatibility only. No active runner writes there. Do not delete,
  migrate, or rewrite historical report artifacts or historical plan paths as part of current eval
  ownership work.

For live engine prerequisites, including the Docker image, host auth, role models, Judge model, and
public versus diagnostic report files, read [`tutorial-engine/evals/README.md`](tutorial-engine/evals/README.md).

## Start points

- Learners: start with [`tutorial/README.md`](tutorial/README.md), then run `npm run tutorial:workbook`.
- Engine developers: start with [`tutorial-engine/README.md`](tutorial-engine/README.md) and its ADRs.
  Synthetic engine-mechanics evals live under [`tutorial-engine/evals/`](tutorial-engine/evals/).
- Curriculum maintainers: edit authored lesson prose under [`tutorial/lessons/`](tutorial/lessons/) and
  canonical lesson specs under [`tutorial/docs/specs/`](tutorial/docs/specs/). Authored-workbook eval
  foundations live under [`evals/workbook/`](evals/workbook/).
- Coding agents: read [`AGENTS.md`](AGENTS.md).
