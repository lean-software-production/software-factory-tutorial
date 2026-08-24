# Task 1 report: session-local learner state foundation

## Summary

Implemented the tutorial-engine session workspace foundation without wiring it into server startup or CLI parsing.

## What changed

- Added `tutorial-engine/src/session-workspace.ts` with:
  - safe generated session IDs and explicit session ID validation;
  - `SessionWorkspaceManager` exposing `contentRoot`, `.tutorial/<id>` session root, and `workspaceRoot`;
  - explicit create/reopen operations;
  - recursive materialization of only `calculator/` and `factory/` from the content root;
  - `node_modules/` exclusion;
  - symlink/path escape rejection for content materialization and reopened sessions;
  - isolated session-local Git initialization with a clean baseline commit.
- Exported the session workspace API from `tutorial-engine/src/index.ts`.
- Added `tutorial-engine/test/session-workspace.test.ts` covering safe IDs, explicit reopen, independent generated workspaces, authored-content immutability, minimal materialization, local Git initialization, and unsafe/missing path rejection.
- Created ADR 0008 using ADRgen in the devcontainer and indexed it in `tutorial-engine/docs/adr/README.md`.

## Verification

- `npm run --workspace=tutorial-engine test -- session-workspace.test.ts` — passed, 8 tests.
- `npm run --workspace=tutorial-engine check` — passed, 40 files / 337 tests.

## Self-review

Reviewed the module and tests against the task brief. One issue found during review: the initial minimal-materialization assertion would not have caught copied directories because it used `readFile()` on directory paths. Replaced it with `lstat()` rejection checks and reran focused and full engine checks.

## Notes / concerns

- ADRgen was run in the devcontainer as required. `devcontainer up` reported a post-create failure while rebuilding `node-pty` because Python is missing in the container image, but the container still started and `devcontainer exec ... adrgen ...` succeeded.
- Server startup and CLI parsing are intentionally untouched for Task 3.

## Critical review fix: pre-existing `.tutorial` symlink

Fixed the Task 1 critical review finding by validating the tutorial state directory before session creation performs recursive workspace creation. `createSession()` now ensures `.tutorial` is either created as a real directory or, if pre-existing, is a non-symlink directory whose real path remains inside the canonical content root. A malicious pre-existing `.tutorial` symlink is rejected before any session directories are created through it.

Added a focused regression test that pre-creates `.tutorial` as a symlink to an outside temporary directory, verifies `createSession()` rejects it, and verifies no escaped session directory was created outside the content root. Existing happy-path session creation/reopen/materialization tests continue to pass.

### Verification output

```text
$ npm run --workspace=tutorial-engine test -- session-workspace.test.ts

> @lean-software-production/tutorial-engine@0.1.0 test
> vitest run --root . session-workspace.test.ts


 RUN  v4.1.10 /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/session-local-learner-state/tutorial-engine


 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  18:33:01
   Duration  1.14s (transform 37ms, setup 0ms, import 50ms, tests 991ms, environment 0ms)
```
