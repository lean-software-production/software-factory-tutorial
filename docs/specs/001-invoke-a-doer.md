# Define success and invoke a doer

Define what a good refactoring looks like, run one agent operation, then review its work yourself.

## Key concept

The heart of every factory is a validation loop: a **doer** changes something, then a **reviewer** validates the change. This first iteration defines success and builds only the doer. You are the reviewer for now.

The doer receives a focused prompt and the success criteria, works in the calculator directory, and may inspect and edit files. It does not run a shell, tests, or quality tools. Keeping those activities outside the doer gives the reviewer independent evidence.

## Decision flow

Show this Mermaid diagram when introducing the iteration:

```mermaid
flowchart LR
    Start([Run run.sh]) --> Doer[Doer\nrefactor.md + success.md]
    Doer --> Human[Human reviewer\nInspect and validate]
    Human --> End([Stop])
```

## Implementation order

Teach and build this iteration in this order. Complete each small step before moving to the next one:

1. **Define success.** Create `factory/success.md` before creating either agent prompt. Describe what a good refactoring of this calculator looks like. Write clear, observable criteria: preserve behaviour, reduce coupling, increase cohesion, avoid duplication, and reduce or at least do not increase complexity. For each criterion, say what evidence a reviewer should examine—for example, tests, a diff, imports and dependencies, or an installed complexity tool. The criteria are the standard that both agents will use. Feel free to coach the learner if they're stuck here. Suggest using Kent Beck's four rules of simple design, for example.
2. **Write the doer prompt.** Create `factory/refactor.md`. Tell the doer to study `../factory/success.md` and that it must use those criteria to choose one small, behaviour-preserving refactoring, and that it must edit files directly. Tell it not to run tests, npm, or shell commands, and to keep its response concise.
3. **Invoke Pi.** Create `factory/run.sh`. Change to the script's directory, then pipe `refactor.md` to Pi running from `calculator/`. Give Pi only file-inspection and file-editing tools; it must not receive its `bash` tool. Use this script:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   echo "Starting doer..."
   cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
   ```

`run.sh` performs one doer turn and exits. It has no Bash loop, validation command, recovery path, or reviewer agent.

## Alternatives: choose another doer

Pi is the default doer, but the boundary is not tied to Pi. Claude Code and Codex can also act as the doer when configured for non-interactive use. Read the same prompt, run the chosen CLI from `calculator/`, and give it only the access you intend. The prompt directs the doer to `../factory/success.md`. For example:

```sh
prompt=$(<refactor.md)
(cd ../calculator && claude -p "$prompt")
(cd ../calculator && codex exec "$prompt")
```

These commands illustrate the shape of the substitution, not a shared security model. Each CLI has different authentication, sandbox, and tool-permission options. Configure it so the doer can inspect and edit the calculator but cannot validate its own work or reach unrelated files.

## Checks

From the repository root, make the script executable and run it:

```sh
chmod +x factory/run.sh
./factory/run.sh
```

Then review the change yourself against `factory/success.md`. Inspect the diff and run independent evidence such as:

```sh
(cd calculator && npm test)
```

You may also run the installed code-quality tools, such as `cognitive-complexity-ts` or `code-health-meter`, to judge whether the refactoring improved the code. Do not ask the doer to run or interpret these checks.

Verify manually that `run.sh` announces the doer before invoking Pi, the doer can study `success.md`, works only in `calculator/`, makes at most one focused change, and cannot invoke a shell tool.

## Pressure test

Manual review makes the distinction between doer and reviewer clear, but it does not scale. The next iteration adds a second agent as a reviewer. It will apply the learner's criteria, run the checks, and report a pass-or-fail verdict for the doer's change.
