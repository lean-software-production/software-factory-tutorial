# Build a doer

Give an agent a job that changes the calculator, and check its work yourself.

## Key concept

A **doer** is the agent that does the job and produces the work product. In this lesson the work product is a change to the calculator, and the doer is the only thing that writes it.

Its boundary is the opposite of the one you drew in the previous lesson. That agent could read and could not change anything; the doer may inspect and edit files, and it may not run a shell, tests, or quality tools. Keeping those activities outside the doer is what makes an independent check possible later: if the doer cannot run the evidence, it cannot report on itself, and the evidence stays available to someone else.

## Implementation order

Teach and build this lesson in this order. Complete each small step before moving to the next one:

1. **Write the doer prompt.** Create `factory/refactor.md`. Nothing else tells the doer what you want, so the prompt states the job directly: choose one small, behaviour-preserving refactoring of the calculator and make it. It must edit files directly. Tell it not to run tests, npm, or shell commands, and to keep its response concise.
2. **Invoke Pi.** Create `factory/refactor-do.sh`. Change to the script's directory, then pipe `refactor.md` to Pi running from `calculator/`. Give Pi only file-inspection and file-editing tools; it must not receive its `bash` tool. Use this script:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   mkdir -p .tmp
   echo "Recording quality baseline..."
   (cd ../calculator && node scripts/quality.mjs) > .tmp/refactor-quality-before.txt || true
   echo "Starting doer..."
   cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
   ```

The first step records a baseline: what `node scripts/quality.mjs` reported about the calculator before the doer touched anything. Run it yourself and you will see what it produces — ESLint findings about complexity and size, knip findings about unused code, and a summary line naming which tool reported anything. It is a list of complaints, not a score. Keeping that list gives the next lesson something to compare against, and a comparison is the only way to tell an improvement from an assertion. The script runs `node scripts/quality.mjs` rather than `npm run quality` because npm appends its own error block to a non-zero exit, which reads as though the script broke when in fact it only reported findings.

Note that the baseline is re-recorded every time you run `refactor-do.sh`. It records the calculator as it stood at the start of *this* turn, not a fixed starting point for the whole of Part 1. That is deliberate: the question worth asking about a turn is whether that turn improved things, and after the second turn a baseline from before the first would no longer answer it.

The two lines around the Pi call are the harness — deterministic code wrapping a model call. Notice that each step announces itself before it runs. Nothing the harness does should be invisible to you, because when a run surprises you the announcements are how you find out which part surprised you.

`refactor-do.sh` performs one doer turn and exits. It has no Bash loop, validation command, recovery path, or second agent.

## Alternatives: choose another doer

Pi is the default doer, but the boundary is not tied to Pi. Claude Code and Codex can also act as the doer when configured for non-interactive use. Read the same prompt, run the chosen CLI from `calculator/`, and give it only the access you intend. From the repository root, for example:

```sh
prompt=$(<factory/refactor.md)
(cd calculator && claude -p "$prompt")
(cd calculator && codex exec "$prompt")
```

These commands illustrate the shape of the substitution, not a shared security model. Each CLI has different authentication, sandbox, and tool-permission options. Configure it so the doer can inspect and edit the calculator but cannot check its own work or reach unrelated files.

## Checks

From the repository root, make the script executable and run it:

```sh
chmod +x factory/refactor-do.sh
./factory/refactor-do.sh
```

Then review the change yourself. Read the diff, and run the evidence the doer was not allowed to run:

```sh
(cd calculator && npm test)
(cd calculator && node scripts/quality.mjs)
```

Do not ask the doer to run or interpret these checks.

Verify manually that `refactor-do.sh` announces each step before invoking Pi, that the doer works only in `calculator/`, makes at most one focused change, and cannot invoke a shell tool.

## Pressure test

You checked this by hand. Read that again: you are the only reason anyone knows whether the change was safe. Nothing in what you built has an opinion about the work it produced.

The next lesson gives that job to an agent.
