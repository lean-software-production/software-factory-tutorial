---
type: terminal-practice
tutor: |-
  Guide the learner through creating factory/refactor.md and factory/refactor-do.sh, making the
  script executable, running it, then checking the diff with npm test and node scripts/quality.mjs
  from outside the doer. Success means the doer prompt asks for one behaviour-preserving
  refactoring, refactor-do.sh records .tmp/refactor-quality-before.txt, invokes Pi from calculator
  with read/edit/write/grep/find/ls and no bash, and announces each phase. Accept equivalent concise
  prompt wording, but not a script that lets the doer run tests or shell commands. If stuck, have
  them compare the tool list and working directory in the displayed script. This matters because
  later lessons depend on the doer producing work without producing its own evidence.
---

## Implementation order

Teach and build this lesson in this order. Complete each small step before moving to the next one:

1. **Write the doer prompt.** Create `factory/refactor.md`. Nothing else tells the doer what you
   want, so the prompt states the job directly: choose one small, behaviour-preserving refactoring
   of the calculator and make it. It must edit files directly. Tell it not to run tests, npm, or
   shell commands, and to keep its response concise.
2. **Invoke Pi.** Create `factory/refactor-do.sh`. Change to the script's directory, then pipe
   `refactor.md` to Pi running from `calculator/`. Give Pi only file-inspection and file-editing
   tools; it must not receive its `bash` tool. Use this script:

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

The first step records a baseline: what `node scripts/quality.mjs` reported about the calculator
before the doer touched anything. Run it yourself and you will see what it produces — ESLint
findings about complexity and size, knip findings about unused code, and a summary line naming which
tool reported anything. It is a list of complaints, not a score. Keeping that list gives the next
lesson something to compare against, and a comparison is the only way to tell an improvement from an
assertion. The script runs `node scripts/quality.mjs` rather than `npm run quality` because npm
appends its own error block to a non-zero exit, which reads as though the script broke when in fact
it only reported findings.

Note that the baseline is re-recorded every time you run `refactor-do.sh`. It records the calculator
as it stood at the start of *this* turn, not a fixed starting point for the whole of Part 1. That is
deliberate: the question worth asking about a turn is whether that turn improved things, and after
the second turn a baseline from before the first would no longer answer it.

The two lines around the Pi call are the harness — deterministic code wrapping a model call. Notice
that each step announces itself before it runs. Nothing the harness does should be invisible to you,
because when a run surprises you the announcements are how you find out which part surprised you.

`refactor-do.sh` performs one doer turn and exits. It has no Bash loop, validation command, recovery
path, or second agent.
