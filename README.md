# Software factory tutorial developer workspace

This repository contains the learner workbook and the local engine that runs it. The authored tutorial
template lives under [`tutorial/`](tutorial/). Each launch creates or reopens a private learner workspace
under `tutorial/.tutorial/<session-id>/workspace/`.

## Architecture map

| Path | Purpose |
| --- | --- |
| [`tutorial/`](tutorial/) | Learner-facing workbook, lessons, specs, seed files, and authored starter trees. |
| [`tutorial-engine/`](tutorial-engine/) | The browser-led workbook engine and its tests. |
| [`scripts/`](scripts/) | Root launchers and setup helpers. |
| [`evals/`](evals/) | Live and deterministic workbook evaluation harnesses. |

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
```

`npm run tutorial:workbook` supplies the embedded terminal with one read-only runtime mount: root
`node_modules/` at the session workspace's `node_modules/`. A normal launch creates a new session;
`--session <id>` reopens an existing workbook session. Earlier workbook event and attempt records remain
readable. The removed browser tutor's ignored state is neither resumed nor migrated.

## Start points

- Learners: start with [`tutorial/README.md`](tutorial/README.md), then run `npm run tutorial:workbook`.
- Engine developers: start with [`tutorial-engine/README.md`](tutorial-engine/README.md) and its ADRs.
- Curriculum maintainers: edit authored lesson prose under [`tutorial/lessons/`](tutorial/lessons/) and
  canonical lesson specs under [`tutorial/docs/specs/`](tutorial/docs/specs/).
- Coding agents: read [`AGENTS.md`](AGENTS.md).
