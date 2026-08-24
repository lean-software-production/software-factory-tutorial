# Task 3 report — launch lifecycle, documentation, and regression coverage

## Summary

Implemented the workbook/root session launch lifecycle and documentation updates for session-local learner state.

- Added `--session <id>` parsing to the shared tutorial argument parser so the workbook launcher can reopen explicit sessions.
- Changed the workbook CLI to create a new session by default, reopen the requested session when `--session` is present, pass the materialized `TutorialSessionPaths` into `startWorkbookServer`, and print the session ID/state/workspace/reopen command.
- Updated root onboarding, workbook CLI, CLI argument, branch-helper, and evaluator session tests for session creation/materialization and explicit reopen.
- Moved evaluator trace/event/artifact capture to the session-local paths.
- Updated learner/developer docs and AGENTS to describe immutable authored content, `tutorial/.tutorial/<session-id>/workspace`, explicit resume, and ignored legacy `.tutorial/.tmp` state.
- Corrected learner prose that still directed commands at `tutorial/` or implied commits land in the cloned tutorial repository.

## Required pre-change investigation: `workbook-server.test.ts` reflection follow-up failure

Before making any Task 3 code change in this continuation, I investigated the reported prior `tutorial-engine check` failure around the reflection follow-up case.

### Reproduction attempts

1. Initial exact-filter attempt:

```sh
cd tutorial-engine
npx vitest run --root . test/workbook-server.test.ts -t 'reflection-follow-up' --reporter=verbose
```

Result: no tests matched that hyphenated filter; Vitest skipped the file.

2. Targeted reflection follow-up cases:

```sh
cd tutorial-engine
npx vitest run --root . test/workbook-server.test.ts -t 'follow-up' --reporter=verbose
```

Result: both follow-up cases passed:

- `rejects a reflection follow-up while the current attempt is reviewing`
- `allows a reflection follow-up after a quiet working review`

3. Single suspected case:

```sh
cd tutorial-engine
npx vitest run --root . test/workbook-server.test.ts -t 'allows a reflection follow-up after a quiet working review' --reporter=verbose
```

Result: passed.

4. Full engine check immediately after the targeted reproduction:

```sh
npm run --workspace=tutorial-engine check
```

Result: passed (`40` test files, `346` tests).

### Error output availability

I could not find a saved prior failure log in the worktree or SDD directory. Because the failure did not reproduce, there was no current full error stack to inspect beyond the successful targeted and full-engine outputs above.

### Recent diff examined

The uncommitted Task 3 diff at investigation time did not modify `tutorial-engine/src/workbook/server.ts` or `tutorial-engine/test/workbook-server.test.ts`. It changed the workbook CLI/session launch path, evaluator session paths, docs, and tests around those surfaces. That makes a deterministic regression in the reflection follow-up server path unlikely.

### Neighboring-test comparison

The stable neighboring tests in `tutorial-engine/test/workbook-server.test.ts` exercise the same progression into the `reflection` block:

- `lets an accepted reflection advance to the next block`
- `rejects a reflection follow-up while the current attempt is reviewing`
- `allows a reflection follow-up after a quiet working review`

The two follow-up tests passed together under the focused `follow-up` run, and the full engine suite passed afterward.

### Root-cause hypothesis

The evidence points to a non-reproducing timing/order flake unrelated to Task 3 rather than a Task 3 production-code defect: the suspected tests passed in isolation, the full engine suite passed, and Task 3 had not touched the workbook server reflection-follow-up implementation. I therefore made no workbook-server production change for that prior failure.

## Implementation details

### Launch lifecycle

- `tutorial-engine/src/cli-arguments.ts`
  - Adds optional `session` to parsed options.
  - Accepts `--session <id>` and `--session=<id>`.
  - Reports a missing session value like other value flags.

- `tutorial-engine/src/workbook/cli.ts`
  - Resolves sessions through `SessionWorkspaceManager`.
  - Creates a fresh session when no `--session` is supplied.
  - Reopens an existing session when `--session` is supplied.
  - Prints session lifecycle lines before serving.
  - Starts the workbook server against immutable content plus explicit session paths.

### Evaluator/session fixtures

- Evaluation workspaces now materialize a fresh session before starting the workbook server.
- Trace metadata records content root, session root, session ID, and session-local workspace root.
- Public events are read from `<sessionRoot>/workbook/events.jsonl`.
- Artifacts are snapshotted from `<workspaceRoot>`.

### Documentation/prose

- `AGENTS.md`, root `README.md`, `tutorial-engine/README.md`, `evals/README.md`, and `tutorial/README.md` now describe authored content as immutable and learner work as session-local.
- Learner docs now instruct users to `cd tutorial/.tutorial/<session-id>/workspace` for lesson commands.
- Resume docs now state that only explicit `--session <id>` resumes and old `.tutorial/.tmp` state is not resumed.
- Branch/commit prose now states commits land in the session-local repository.

## Validation results

Focused suites:

```sh
cd tutorial-engine && npx vitest run --root . test/cli-arguments.test.ts test/workbook-cli.test.ts --reporter=verbose
```

Passed: `2` files, `18` tests.

```sh
npm run test:onboarding
```

Passed: `18` tests.

```sh
npm run check:eval && npm run test:eval
```

Passed: eval typecheck and `6` eval test files / `22` tests.

Prior-failure reproduction:

```sh
cd tutorial-engine && npx vitest run --root . test/workbook-server.test.ts -t 'follow-up' --reporter=verbose
cd tutorial-engine && npx vitest run --root . test/workbook-server.test.ts -t 'allows a reflection follow-up after a quiet working review' --reporter=verbose
```

Passed: both reflection follow-up tests, then the single suspected case.

Full validations after the final doc correction:

```sh
npm run --workspace=tutorial-engine check:workbook
```

Passed: `Software Factory Tutorial: 13 lesson(s), 2 part(s).`

```sh
npm run check
```

Passed: onboarding, eval typecheck/tests, tutorial-engine typecheck/tests (`40` files / `346` tests), and calculator build/tests (`1` file / `9` tests).

Repository hygiene:

```sh
git diff --check
```

Passed.

## Self-review

Reviewed the final diff for Task 3 scope. One issue found and fixed during self-review: `tutorial/README.md` still told learners to `cd tutorial` and export `../node_modules/.bin`; it now points them at the printed session workspace and uses the correct relative path back to root `node_modules/.bin`.

No remaining concerns found in the Task 3 diff.

## Important review findings fix

Addressed the Task 3 important review findings in this follow-up commit:

- Updated `.devcontainer/README.md` so the devcontainer flow no longer tells learners to `cd tutorial` for factory/calculator work; it now tells them to use the printed private session workspace.
- Updated `tutorial-engine/README.md` to document the workbook entry point as `npm run dev:workbook -- ../tutorial` and clarified that the root `npm run tutorial` command is the convenience launcher for the same workbook entry point.
- Reworded current learner lesson blocks and canonical lesson specs under `tutorial/` so command-location prose says `session workspace` instead of `tutorial root`, including the reviewer-cited lesson 001 and lesson 002 blocks.

Follow-up validation:

```sh
npm run --workspace=tutorial-engine check:workbook
npm run test:onboarding
git diff --check
```

Result: all passed. `check:workbook` reported `Software Factory Tutorial: 13 lesson(s), 2 part(s).`; onboarding reported 18 passing tests.
