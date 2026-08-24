# Task 1 report — move tutorial workspace and preserve launch behavior

## Scope observed

Worked only in the isolated worktree:

`/Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/separate-tutorial-content`

Read the task brief and the parent plan before changing the interrupted implementation. I stayed within Task 1: moving the authored learner workspace to `tutorial/`, preserving root workbook launch behavior, updating root npm/workbook defaults, and updating deterministic tests. I did not start navigation rewriting, historical plan labelling, evaluator migration, or obsolete-file cleanup.

## Implementation completed

- Moved the learner-authored workspace into `tutorial/` using git-tracked renames:
  - `README.md` -> `tutorial/README.md`
  - `workbook.md` -> `tutorial/workbook.md`
  - `parts/` -> `tutorial/parts/`
  - `lessons/` -> `tutorial/lessons/`
  - `docs/GLOSSARY.md`, `docs/specs/`, and `docs/seeds/` -> `tutorial/docs/...`
  - `factory/` -> `tutorial/factory/`
  - `calculator/` -> `tutorial/calculator/`
- Updated root npm metadata:
  - root workspace entry now points at `tutorial/calculator`.
  - root `check` uses `--workspace=tutorial/calculator` for the calculator tests.
  - `package-lock.json` now reflects the nested calculator workspace link.
- Preserved root launch behavior for the workbook tutor:
  - `npm start` delegates to `npm run tutorial`.
  - `scripts/tutorial.mjs` launches `tutorial-engine`'s `dev:workbook` command with the explicit `tutorial/` target and forwards additional CLI arguments after that target.
  - `scripts/tutorial-workbook.mjs` also passes the explicit `tutorial/` target.
- Updated workbook structural check defaults:
  - `check:workbook` now defaults to the repository's `tutorial/` workspace, resolved from `tutorial-engine/src/workbook/check.ts` rather than from process cwd.
  - Explicit workbook-check targets remain honored, preserving generic workbook engine behavior.
- Updated `.gitignore`:
  - learner run artifacts under `tutorial/factory/**/.tmp/` and tutor state under `tutorial/.tutorial/` are ignored.
  - pre-migration root-local `.tutorial/` and `factory/**/.tmp/` remain ignored so existing local learner state is not exposed by the move.
- Updated deterministic tests affected by the move:
  - root onboarding tests assert the launcher target and calculator workspace path.
  - gitignore tests assert the new nested factory/state paths.
  - lesson/seed/workbook contract tests load the authored tutorial from `tutorial/`.
  - workbook-check tests assert the new default target and explicit-target behavior.
- Corrected one remaining engine comment to describe workbook documents as relative to a workbook target rather than authored at repository root.

## Debugging note

The first full `tutorial-engine` test run exposed seven failures in `tutorial-engine/test/workbook-contract.test.ts`. The failures all had the same root cause: several real-workbook assertions still called `loadWorkbook(resolve(import.meta.dirname, "../.."))`, which now points at the repository root where `workbook.md` no longer exists. I replaced those real-workbook calls with the shared `REAL_WORKBOOK_ROOT` pointing at `../../tutorial`. The full engine check then passed.

## Testing

Commands run from the isolated worktree unless noted:

1. `npm run --workspace=tutorial-engine test`
   - Initial run failed: 38 files passed, 1 file failed, 7 tests failed in `workbook-contract.test.ts` because real-workbook tests still loaded the repository root.
2. `npm run --workspace=tutorial-engine test`
   - Passed after fixing the real-workbook target: 39 test files, 329 tests.
3. `npm run test:onboarding && npm run --workspace=tutorial-engine check:workbook`
   - Passed: 18 onboarding tests; workbook check reported `Software Factory Tutorial: 13 lesson(s), 2 part(s).`
4. `npm run --workspace=tutorial-engine check`
   - Passed: `tsc --noEmit` and 39 Vitest files / 329 tests.
5. `npm run --workspace=tutorial/calculator test`
   - Passed: calculator build and 1 Vitest file / 9 tests.
6. `npm run --workspace=tutorial-engine test -- gitignore.test.ts`
   - Passed after retaining legacy root-local ignores: 1 file / 4 tests.
7. Final verification bundle:
   - `npm run --workspace=tutorial-engine check` — passed: `tsc --noEmit` and 39 Vitest files / 329 tests.
   - `npm run test:onboarding` — passed: 18 tests.
   - `npm run --workspace=tutorial-engine check:workbook` — passed from repository root.
   - `(cd tutorial-engine && npm run check:workbook)` — passed from the engine workspace.
   - `npm run --workspace=tutorial/calculator test` — passed: build and 9 tests.

I did not run the full root `npm run check` because it includes eval suites that the parent plan assigns to Task 3; I avoided touching or validating evaluator migration work in this task.

## Self-review

- Confirmed the specified learner content now exists under `tutorial/` and the old tracked root paths are represented as renames.
- Confirmed root launcher tests prove arguments are forwarded after the explicit `tutorial/` target.
- Confirmed `check:workbook` defaults to `tutorial/` and also works when invoked from `tutorial-engine/`.
- Confirmed calculator workspace commands work through the new nested workspace path.
- Confirmed the engine loader remains target-generic; only the root/default workbook-check and launch targets point at this repository's `tutorial/` workspace.
- Confirmed no navigation rewrite, historical labelling, eval migration, or obsolete-file cleanup was included.

## Concerns / follow-up for later tasks

- Root `README.md` is currently moved to `tutorial/README.md`; Task 2 is expected to add/rewrite the root developer README and update learner navigation prose.
- Evaluation fixtures/tests and broader docs still may refer to the old root tutorial layout; that is explicitly reserved for Task 3 / Task 2 per the plan.
