---
type: terminal-practice
outcome: "Create a run script that records a baseline, runs the doer, validates, and pauses after each iteration."
tutor: |-
  Guide the learner through the four build steps: move the Part 1 files into factory/refactor/,
  repair stale paths and names, write success.md, update do.sh and validate.sh to receive
  success.md, and create run.sh. Success means the moved scripts run from the session workspace, the
  validator gives one finding per criterion, run.sh orders baseline, doer, validator, and pause, and
  .tmp/validate-findings.txt holds the last verdict. Accept learner-written success criteria if they
  name runnable evidence for each criterion. Clue from the listed mv commands and the
  ../../calculator path change when scripts fail after the move. The why is that the line needs an
  edge, shared criteria, and fixed station order before it can run as a line.
---

## Implementation order

Work in this order. Complete each small step before moving to the next one:

1. **Give the line an edge.** From the session workspace:

   ```sh
   mkdir -p factory/refactor/.tmp
   mv factory/refactor-do.sh                   factory/refactor/do.sh
   mv factory/refactor-validate.sh             factory/refactor/validate.sh
   mv factory/refactor.md                      factory/refactor/refactor.md
   mv factory/refactor-validate.md             factory/refactor/validate.md
   mv factory/.tmp/refactor-quality-before.txt factory/refactor/.tmp/quality-before.txt
   ```

   That is plain `mv`, not `git mv`: nothing in `factory/` has been committed yet, so there is
   nothing in git's index for `git mv` to move.

   Lesson 004 also left `factory/.tmp/refactor-validate-findings.txt` behind. Delete it; it is last
   week's output, and the line writes its own.

   The `refactor-` prefixes drop because the folder now carries the line's name. Nothing inside the
   folder should still be called `refactor-` anything, except `refactor.md` — that name belongs to
   the doer's job, not to the line.

   The scripts do not survive the move untouched. Fix every stale name inside them:

   - both scripts sit one directory deeper, so each `(cd ../calculator && ...)` becomes
     `(cd ../../calculator && ...)`;
   - `.tmp/refactor-quality-before.txt` becomes `.tmp/quality-before.txt`, in the line that writes
     it and in
     `validate.sh`'s guard;
   - `refactor-validate.md` becomes `validate.md`, and `.tmp/refactor-validate-findings.txt` becomes
     `.tmp/validate-findings.txt`;
   - the guard's message now names the script you would actually run: `./do.sh`.

   Run `./factory/refactor/do.sh` and `./factory/refactor/validate.sh` once from the session workspace
   before going on. A rename that nobody exercises is a rename nobody has checked.

   Nothing behaves differently after this step, which is the point worth making. What you bought
   is an edge. A second line — one that writes documentation, say — would be a second folder
   sitting alongside this one, with its own prompts and its own criteria, and a factory is what
   holds them both. The line had to have an edge before it could be named.

2. **Define success.** Create `factory/refactor/success.md`. It describes the calculator the line is
   working towards: not the next refactoring, but what the code should look like after many of them.
   Write it in your own terms, and default to Kent Beck's four rules of simple design, in order:

   - passes its tests;
   - reveals intention;
   - no duplication;
   - fewest elements.

   For each rule, name the evidence a validator can quote. Evidence means a command whose output
   it can paste back — `npm test`, `node scripts/quality.mjs`, a `grep -n` that puts two
   near-identical passages side by side with their line numbers. It does not mean the name of a
   tool the validator would have to work out how to install and run. The validator can only quote
   what it can actually run from `calculator/`.

   These criteria are a strategy for the whole line, not a checklist for the next change. The reason
   is worth saying out loud. The validator in lesson 003 knew one check — had the change reduced
   what
   `node scripts/quality.mjs` reports? — and that was enough while a human read every verdict,
   because
   the human supplied everything the check left out. A line that runs unattended has no such human.
   Its criteria have to outlive a single turn.

3. **Point both prompts at the criteria.** Neither `refactor.md` nor `validate.md` carries its own
   criteria any more. Both defer to `success.md`, which arrives appended to the prompt — the same
   trick lesson 003 used to hand the validator its baseline. Neither prompt names a path to go and
   fetch, because both stations run from `calculator/` and neither needs to reach outside it.

   Which means every caller has to hand the criteria over, and there are now three of them. Update
   `do.sh`:

   ```sh
   cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
   ```

   and `validate.sh`:

   ```sh
   cat validate.md success.md .tmp/quality-before.txt \
     | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
     | tee .tmp/validate-findings.txt
   ```

   Miss either one and that script goes on sending a prompt that defers to criteria nobody hands it.

   This is the reason the criteria live in a file of their own rather than inside the two prompts:
   three callers now hand the same criteria to two stations, and a copy in each prompt would drift.
   One of them would be edited, the other would not, and the doer and the validator would quietly
   stop working towards the same thing.

   The validator must give one finding for every criterion in `success.md`, in this format:

   ```text
   VERDICT: PASS

   FINDINGS:
   - [PASS] <success criterion>: <specific evidence>
   - [FAIL] <success criterion>: <specific evidence>
   ```

   Two things to tell it plainly. It must not expect one small refactoring to reach the whole
   destination — the criteria describe where the line is going, and a single change is one step
   along
   that road. And a passing test alone is not a passing verdict: the first rule is one of four, and
   the other three still need evidence.

4. **Run the line.** Create `factory/refactor/run.sh`:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   mkdir -p .tmp
   while true; do
     echo "Recording quality baseline..."
     (cd ../../calculator && node scripts/quality.mjs) > .tmp/quality-before.txt || true
     echo "Starting doer..."
     cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
     echo "Starting validation..."
     cat validate.md success.md .tmp/quality-before.txt \
       | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
       | tee .tmp/validate-findings.txt
     read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
   done
   ```

   The validator's `cat` carries three files, in the order the validator was taught to expect them:
   its job, the criteria, then the baseline it is comparing against. Leave `.tmp/quality-before.txt`
   out
   and the instruction in `validate.md` to compare against the baseline below would point at
   nothing.

   `validate.sh` guards against a missing baseline. `run.sh` needs no such guard, because it writes
   the baseline and hands it over in the same pass. The guard was never about a file existing on
   disk; it is about the validator receiving something to compare against.

   `do.sh` and `validate.sh` still run on their own, exactly as they did. The line did not replace
   them. It ordered them.

   One turn of this loop is an **iteration**: baseline, doer, validator, pause. That is the bounded
   batch of agent work between check-ins. Each `echo` names a phase within the iteration, not an
   iteration of its own. The `read` is where the line hands control back to you, and Ctrl-C at that
   prompt stops the line.

   With that written, the folder is the whole line:

   ```text
   factory/refactor/
     do.sh              validate.sh          run.sh
     refactor.md        validate.md          success.md
     .tmp/quality-before.txt .tmp/validate-findings.txt
   ```

   Three scripts, three prompts, and the two files the stations pass between them.
