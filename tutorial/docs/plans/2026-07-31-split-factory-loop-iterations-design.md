# Split factory loop iterations design

## Goal

Split the first factory lesson into two small iterations. Learners first build a repeated, unvalidated refactoring loop. They then add independent test validation and a recovery branch.

## Iteration 001: Unvalidated refactoring loop

The learner creates `factory/refactor.md` and `factory/factory.sh`. The shell loop runs Pi from `calculator/`, gives it only file-inspection and editing tools, and pauses after each refactoring turn.

The lesson shows the smallest loop: refactor, pause, repeat. It does not run tests or create recovery files.

The teaching explains why Pi must not validate its own work. We could give the agent permission to run `npm test`, but its report is not independent evidence: it might skip the command, misread its output, or claim success without a successful run. Bash must execute the test outside the agent loop before the result is trustworthy.

Its pressure test is a broken calculator after a refactoring. Nothing detects the break, which motivates the next iteration.

## Iteration 002: Validation and recovery

The learner adds `factory/fix-tests.md`, independent `npm test` execution, and `test-failure.log`.

After every Pi turn, Bash runs the tests. A passing result clears stale failure evidence. A failing result writes standard error to `test-failure.log`. On the next iteration, the script selects `fix-tests.md` and the saved evidence instead of `refactor.md`.

The tutorial describes this branch as ordinary work and healing, while the shell names the concrete prompt files directly. Its diagram and manual checks cover both paths.

## Compatibility

Replace the existing single iteration with these two `Todo` rows in the ledger. The tutorial engine already selects the first Todo row, so it will begin with the unvalidated loop without an engine change.
