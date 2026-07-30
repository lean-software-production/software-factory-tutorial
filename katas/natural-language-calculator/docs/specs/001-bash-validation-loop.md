# 001 — Bash validation loop

## Goal

Build the smallest useful software factory. On each iteration, Pi makes one small refactoring to the calculator. Bash runs the tests independently, shows the result, and waits for the learner.

The learner should be able to read the entire factory in under a minute.

## Behaviour

Create these files at the kata root:

- `factory.sh`
- `work.md`
- `heal.md`

`work.md` tells Pi to inspect the current code and make one small, behaviour-preserving refactoring. `heal.md` tells Pi to inspect supplied failing test output and make the smallest correction it can infer. Both prompts tell Pi to edit files directly, not run tests or shell commands, and keep its response concise.

`factory.sh` loops until the learner stops it. Each iteration:

1. Checks for `test-failure.log`.
2. If it is absent, runs Pi with `work.md`.
3. If it is present, runs Pi with `heal.md` followed by the contents of `test-failure.log`.
4. Runs Pi with file-inspection and file-editing tools only. Pi must not receive its `bash` tool.
5. Runs `npm test`, capturing both standard output and standard error without terminating the loop when tests fail.
6. Prints the captured test output unchanged.
7. If the tests fail, writes that output to `test-failure.log`. If they pass, deletes `test-failure.log` if it exists.
8. Pauses until the learner presses Enter; Ctrl-C stops the factory.

A failing test result becomes the input to the next Pi turn without making Pi responsible for validation. A passing test removes that recovery state, so the next turn resumes ordinary work.

## Decision flow

Show this Mermaid diagram when introducing the iteration:

```mermaid
flowchart TD
    Start([Start / press Enter]) --> Failed{test-failure.log exists?}
    Failed -- No --> Work[work.md\nImplement next refactoring]
    Failed -- Yes --> Heal[heal.md + test-failure.log\nAttempt to fix tests]
    Work --> Pi[Pi edits files\nNo shell tool]
    Heal --> Pi
    Pi --> Test[npm test\nBash validates]
    Test --> Passed{Tests pass?}
    Passed -- Yes --> Remove[Delete test-failure.log]
    Passed -- No --> Save[Write stderr to test-failure.log]
    Remove --> Pause[Show result and pause]
    Save --> Pause
    Pause --> Start
```

## Example

A first run uses `work.md` to change one small part of the calculator, then the shell prints a green test run and pauses. The next run again uses `work.md`.

If a run makes a mistake, the shell prints the failing output, saves it as `test-failure.log`, and pauses. After Enter, Pi receives `heal.md` and that failure log. It makes the smallest correction it can infer, after which Bash tests again. Once the tests pass, Bash deletes the failure log and the next turn returns to `work.md`.

## Checks

From the kata directory:

```sh
./factory.sh
```

Verify manually that:

- Pi can read and edit the kata but cannot invoke a shell tool.
- `npm test` runs after every Pi turn.
- a failing `npm test` does not end the factory.
- a failed test creates `test-failure.log`, and the next Pi turn uses `heal.md` with that output;
- a passing test deletes `test-failure.log`, and the next Pi turn uses `work.md`.
- the learner can stop the loop with Ctrl-C.

## Out of scope

Do not add commits, run logs, structured state, retries, roles, parallel agents, a workflow graph, or automatic recovery. Those pressures belong to later iterations.

## Pressure test

The factory has only one worker and one opaque prompt. It cannot show why a particular refactoring was chosen, distinguish focused from broad validation, or safely divide independent work. Later iterations will add only the next piece needed to relieve those pressures.
