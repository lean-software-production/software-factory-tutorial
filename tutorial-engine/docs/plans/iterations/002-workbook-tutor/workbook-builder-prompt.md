You are the workbook-tutor implementation subagent. Work on the `workbook-tutor` branch. Implement the
lesson-001 workbook vertical slice now; do not write another plan or ask for clarification.

Read, in full:

- `AGENTS.md`
- `tutorial-engine/AGENTS.md` if present
- `tutorial-engine/docs/plans/iterations/002-workbook-tutor/spec.md`
- `tutorial-engine/docs/plans/iterations/002-workbook-tutor/implementation-plan.md`
- `docs/specs/001-run-an-agent-headlessly.md`
- `docs/GLOSSARY.md`
- the current `tutorial-engine/` package layout and its tests

## Scope

Keep the legacy tutor untouched: `npm run tutorial` and its browser, server, state, and tests must retain
their current behaviour. Add a separate workbook command at the repository root:

```sh
npm run tutorial:workbook
```

Implement the workbook as an isolated entry point inside `tutorial-engine/`:

- server and CLI modules under `tutorial-engine/src/workbook/`;
- a distinct browser app under `tutorial-engine/web-workbook/`;
- a distinct build output under `tutorial-engine/dist/web-workbook/`;
- no database;
- no filesystem watcher yet; and
- no persistent chat transcript or page-wide chat input.

You may edit root `package.json` and add a root launch script only as needed for `tutorial:workbook`.
Otherwise keep implementation work in `tutorial-engine/`.

## Required behaviour

1. Store workbook state only under `factory/.tmp/workbook/`.
2. Use an append-only JSONL event log as the source of truth. A pure projection derives lesson and block
   progress; a projection cache may exist but must be rebuildable from events.
3. Implement a minimal validated lesson contract with ordered, stable block instances. It must be enough
   for lesson 001: narrative, terminal practice, reflection, and lesson transition.
4. Render a continuous-workbook shell with squared paper, generous serif narrative typography, and a left
   curriculum rail. The rail lists all lessons; only migrated lesson 001 has rendered content and a local
   outline. Other lessons are explicitly unavailable chapter stubs, not fake readable narrative.
5. Keep viewed lesson/scroll position separate from progress. Resume opens the active block; scrolling
   cannot advance progress.
6. Port lesson 001 as a draft workbook lesson, preserving its existing teaching order and vocabulary. It
   must expose key concepts and learning outcomes clearly. Mark new curriculum material as draft pending
   human review; do not claim it has been approved.
7. Terminal-practice blocks show the exact command, repository-root context, expected observation, and
   local controls. The engine never executes learner terminal commands. An acknowledgement completes an
   expected observation; an “I saw something different” submission records evidence but leaves the block
   active for help and retry.
8. Provide static, inline contextual help for common lesson-001 requests. Include a small block-scoped
   “Something else” interaction, but do not create a global chat. If model-backed free-text help cannot be
   added without weakening its block scope, leave the adapter seam explicit and report the gap rather than
   substituting general chat.
9. Reflections record participation, never correctness. Lesson completion requires both terminal practices,
   the reflection, and the explicit transition action.

## Tests and verification

Add focused deterministic tests for the contract, event replay/projection, progress transitions, resume,
legacy/workbook state separation, and browser interactions for lesson 001. Do not use real model calls in
deterministic tests. Run the relevant build and test commands before finishing.

Do not modify learner state, calculator source, or curriculum ledger progress. Do not implement lesson 002
or watcher support.

Report changed paths, commands run and results, deliberate deferrals, and anything requiring human
curriculum review.
