---
type: terminal-practice
tutor: |-
  Guide the learner through creating repair.md and commit.md, then editing run.sh to parse an
  anchored verdict and route FAIL or unreadable output to repair and PASS to commit. Success means
  repair receives findings, PASS writes a clean commit message to .tmp/commit-message.txt and
  commits only calculator files, FAIL produces no commit, and the provided grep experiments
  demonstrate why the ^ anchor matters. Accept a simulated verdict file to exercise branches if the
  model does not naturally produce both outcomes. Clue toward message="$PWD/commit-message.txt" if
  the commit cannot find the message file. The point is that the orchestrator recognises output
  shapes and gives verdicts consequences.
---

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Write the repair prompt.** Create `factory/refactor/repair.md`. Its job to be done is narrower
   than
   the doer's: given the validator's findings, make the smallest change that addresses them. It does
   not start a new refactoring, and it does not go looking for other things worth improving. Same
   tools
   as the doer, and the same prohibition on running checks.

   This is still a doer. It changes code, it is handed a job and run to completion, and it is judged
   by
   the validator like anything else on the line. What it has is a narrower job, not a new role.

   The obvious question is why the doer's own prompt will not do, when lesson 004 handed it the
   findings
   and it behaved. The answer is that a human chose to run it that way, once. `refactor.md` tells a
   station to find something worth improving and improve it; hand that station some findings and
   they
   become one more thing in its context, competing with the job it was actually given. On an
   unattended
   loop it will pick something new most times it is asked. Give a station one job, and repair's job
   is
   not the doer's job.

   Keep the prohibition on running checks for the same reason the doer has it. The validator holds
   the
   only judgement on this line, and a station that grades its own work has no reason to report a
   problem with it.

   Like every other prompt on the line, `repair.md` names no path to go and fetch. Its inputs — the
   criteria and the findings — arrive appended to it by the caller.

2. **Write the commit prompt.** Create `factory/refactor/commit.md`. Given the diff and the
   validator's
   findings, it writes the commit message for the change that was just made: a subject line under 72
   characters, a blank line, then two or three lines saying what changed and which success criteria
   it
   moved.

   It must not run anything, it must not edit anything, and it must emit **only** the message — no
   preamble, no code fences, no "here is the commit message".

   Its tools are `read,grep,find,ls`. It cannot commit, and it is not meant to.

3. **Branch on the verdict.** `run.sh` takes the first line of `.tmp/validate-findings.txt` that
   *begins*
   with `VERDICT: PASS` or `VERDICT: FAIL`, and chooses what happens next:

   ```sh
   verdict=$(grep -m1 -o '^VERDICT: \(PASS\|FAIL\)' .tmp/validate-findings.txt || echo "VERDICT: FAIL")
   if [ "$verdict" = "VERDICT: FAIL" ]; then
     echo "Starting repair..."
     cat repair.md success.md .tmp/validate-findings.txt \
       | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
   else
     echo "Starting commit..."
     cat commit.md success.md .tmp/validate-findings.txt .tmp/evidence.txt \
       | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \
       > .tmp/commit-message.txt
     message="$PWD/commit-message.txt"
     (cd ../../calculator && git add -- . && git commit -q -F "$message")
   fi
   ```

   Each station gets its inputs in the order it was taught to expect them: its job, the criteria,
   then
   whatever it is working from. Leave the findings out of repair and it has nothing to repair.

   That `message=` line is not ceremony, and it is worth being precise about why. `run.sh` has
   already
   done `cd "$(dirname "$0")"`, so `$PWD` is the line's folder — but only until the subshell runs
   `cd ../../calculator`. A shell expands each command's arguments when that command is about to
   run,
   not when it reads the line, so a `"$PWD/commit-message.txt"` written inside the subshell would be
   expanded *after* the `cd` and resolve to `calculator/commit-message.txt`, which does not exist.
   The
   commit would fail, `set -e` would end the run, and the staging done by `git add` would be left
   behind. Capturing the path into `message` first pins it while `$PWD` still means the line's
   folder.

   `git add -- .` from inside `calculator/` stages that directory and nothing else. That pathspec is
   what keeps the learner's own work out of a station's commit: `factory/` is tracked too, and a
   bare
   `git add` from anywhere in the repository would sweep the line's own source into the change it is
   supposed to be recording.

   That block goes after the validation phase and before the `read`. The first three lines of
   `run.sh`
   are unchanged and are not repeated here; keep them.

4. **Run the line.** Get one of each verdict before moving on. A rename that nobody exercises is a
   rename nobody has checked, and a branch nobody has taken both ways is worse.
