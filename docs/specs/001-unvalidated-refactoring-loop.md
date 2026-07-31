# Unvalidated refactoring loop

Build the smallest repeated refactoring loop.

## Key concept

A factory starts by repeating one useful action. Bash owns the loop and invokes Pi as a worker; the worker can inspect and edit the calculator but cannot use a shell.

## Decision flow

Show this Mermaid diagram when introducing the iteration:

```mermaid
flowchart TD
    Start([Start / press Enter]) --> Refactor[refactor.md\nAsk Pi for one refactoring]
    Refactor --> Pause[Pause for learner]
    Pause --> Start
```

## Behaviour

Create these files in `factory/`:

- `factory/factory.sh`
- `factory/refactor.md`

`refactor.md` tells Pi to inspect the calculator and make one small, behaviour-preserving refactoring. It tells Pi to edit files directly, not run tests, npm, or shell commands, and keep its response concise.

`factory/factory.sh` loops until the learner stops it. It runs Pi from `calculator/`, so Pi works only on the kata. Each iteration:

1. Pipes `refactor.md` to Pi.
2. Gives Pi only file-inspection and file-editing tools; Pi must not receive its `bash` tool.
3. Pauses until the learner presses Enter; Ctrl-C stops the factory.

Use this exact Pi invocation:

```sh
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
```

## Checks

From the repository root:

```sh
./factory/factory.sh
```

Verify manually that Pi can inspect and edit the calculator, cannot invoke a shell tool, and the loop waits for Enter before the next turn.

## Pressure test

A refactoring can break the calculator and this loop will continue without noticing. We could let Pi run `npm test` itself, but an agent report is not independent evidence: it might skip the command, misread the output, or claim success without a successful run. Bash must run the test outside the agent loop before the result is trustworthy. The next iteration adds that independent validation and a recovery path.
