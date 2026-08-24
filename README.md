# Software factory tutorial developer workspace

This repository contains a learner tutorial and the local engine that runs it. The repository root is the developer workspace; the authored learner workspace lives under [`tutorial/`](tutorial/).

## Architecture map

| Path | Purpose |
| --- | --- |
| [`tutorial/`](tutorial/) | Learner-facing workbook, lessons, specs, seed files, `factory/`, and the calculator kata. Learner lesson commands run from this directory. |
| [`tutorial-engine/`](tutorial-engine/) | Generic browser-led workbook engine and its tests. The root launcher points it at `tutorial/`. |
| [`scripts/`](scripts/) | Root convenience launchers and setup helpers. |
| [`evals/`](evals/) | Live and deterministic tutor evaluation harnesses. |
| [`docs/plans/`](docs/plans/), [`docs/superpowers/plans/`](docs/superpowers/plans/), [`tutorial-engine/docs/plans/`](tutorial-engine/docs/plans/) | Historical planning records; paths inside them may predate the `tutorial/` split. |

## Root commands

Run these from the repository root:

```sh
npm install                 # install root, engine, and calculator workspaces
npm run setup               # check Node, npm, Pi, and configured tutor models
npm run tutorial            # convenience launcher for tutorial/ in the workbook engine
npm run --workspace=tutorial-engine check:workbook
```

Useful developer checks:

```sh
npm run test:onboarding
npm run --workspace=tutorial-engine check
npm run --workspace=tutorial/calculator test
npm run check:eval
npm run test:eval
```

`npm run check` runs the full deterministic root check. `npm run eval` is the explicit live evaluator command and may spend model tokens.

## Start points

- Learners: start with [`tutorial/README.md`](tutorial/README.md). Start the tutor with the root `npm run tutorial` convenience command, then run lesson shell commands from the `tutorial/` root.
- Engine developers: start with [`tutorial-engine/README.md`](tutorial-engine/README.md) and ADRs in [`tutorial-engine/docs/adr/`](tutorial-engine/docs/adr/).
- Curriculum maintainers: edit authored lesson prose under [`tutorial/lessons/`](tutorial/lessons/) and canonical lesson specs under [`tutorial/docs/specs/`](tutorial/docs/specs/).
- Coding agents: read [`AGENTS.md`](AGENTS.md) for the repository map, workflow rules, and curriculum-writing conventions.
