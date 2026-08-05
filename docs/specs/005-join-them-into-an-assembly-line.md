# Join them into an assembly line

Give the two agents a boundary, a fixed order, and criteria that outlive a single turn.

## Key concept

Make the move first, then take the name.

The move is small: put the doer and the validator in one folder, and run them in a fixed order. Once
that is done there is something to point at, and the words are worth having.

An **assembly line** is an ordered sequence of **machines**, each machine's output feeding the next.
A **machine** is an agent running in a non-interactive harness — handed its inputs, run to
completion, no human in the conversation. A **factory** is the software containing one or more
lines.

The learner has been building machines since lesson 001, without the word for it. Every one of them
was an agent, headless, handed its input by a script. What this lesson adds is not a new kind of
thing; it is the order they run in, and the edge around them.

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Give the line an edge.** From the repository root:

   ```sh
   mkdir factory/refactor
   mv factory/refactor-do.sh              factory/refactor/do.sh
   mv factory/refactor-validate.sh        factory/refactor/validate.sh
   mv factory/refactor.md                 factory/refactor/refactor.md
   mv factory/refactor-validate.md        factory/refactor/validate.md
   mv factory/refactor-quality-before.txt factory/refactor/quality-before.txt
   ```

   That is plain `mv`, not `git mv`: `factory/` is git-ignored, so none of the learner's work is
   tracked and there is nothing for git to move.

   Lesson 004 also left `factory/refactor-validate-findings.txt` behind. Delete it; it is last
   week's output, and the line writes its own.

   The `refactor-` prefixes drop because the folder now carries the line's name. Nothing inside the
   folder should still be called `refactor-` anything, except `refactor.md` — that name belongs to
   the doer's job, not to the line.

   The scripts do not survive the move untouched. Fix every stale name inside them:

   - both scripts sit one directory deeper, so each `(cd ../calculator && ...)` becomes
     `(cd ../../calculator && ...)`;
   - `refactor-quality-before.txt` becomes `quality-before.txt`, in the line that writes it and in
     `validate.sh`'s guard;
   - `refactor-validate.md` becomes `validate.md`, and `refactor-validate-findings.txt` becomes
     `validate-findings.txt`;
   - the guard's message now names the script the learner would actually run: `./do.sh`.

   Run `./factory/refactor/do.sh` and `./factory/refactor/validate.sh` once from the repository root
   before going on. A rename that nobody exercises is a rename nobody has checked.

   Nothing behaves differently after this step, which is the point worth making. What the learner
   bought is an edge. A second line — one that writes documentation, say — would be a second folder
   sitting alongside this one, with its own prompts and its own criteria, and a factory is what holds
   them both. The line had to have an edge before it could be named.

2. **Define success.** Create `factory/refactor/success.md`. It describes the calculator the line is
   working towards: not the next refactoring, but what the code should look like after many of them.
   Have the learner write it in their own terms, and default to Kent Beck's four rules of simple
   design, in order:

   - passes its tests;
   - reveals intention;
   - no duplication;
   - fewest elements.

   For each rule, name the evidence a validator can quote. Evidence means a command whose output it
   can paste back — `npm test`, `node scripts/quality.mjs`, a `grep -n` that puts two near-identical
   passages side by side with their line numbers. It does not mean the name of a tool the validator
   would have to work out how to install and run. The validator can only quote what it can actually
   run from `calculator/`.

   These criteria are a strategy for the whole line, not a checklist for the next change. The reason
   is worth saying out loud. The validator in lesson 003 knew one check — had the change reduced what
   `node scripts/quality.mjs` reports? — and that was enough while a human read every verdict, because
   the human supplied everything the check left out. A line that runs unattended has no such human.
   Its criteria have to outlive a single turn.

3. **Point both prompts at the criteria.** Neither `refactor.md` nor `validate.md` carries its own
   criteria any more. Both defer to `success.md`, which arrives appended to the prompt — the same
   trick lesson 003 used to hand the validator its baseline. Neither prompt names a path to go and
   fetch, because both machines run from `calculator/` and neither needs to reach outside it.

   Which means every caller has to hand the criteria over, and there are now three of them. Update
   `do.sh`:

   ```sh
   cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
   ```

   and `validate.sh`:

   ```sh
   cat validate.md success.md quality-before.txt \
     | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
     | tee validate-findings.txt
   ```

   Miss either one and that script goes on sending a prompt that defers to criteria nobody hands it.

   This is the reason the criteria live in a file of their own rather than inside the two prompts:
   three callers now hand the same criteria to two machines, and a copy in each prompt would drift.
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
   destination — the criteria describe where the line is going, and a single change is one step along
   that road. And a passing test alone is not a passing verdict: the first rule is one of four, and
   the other three still need evidence.

4. **Run the line.** Create `factory/refactor/run.sh`:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   while true; do
     echo "Recording quality baseline..."
     (cd ../../calculator && node scripts/quality.mjs) > quality-before.txt || true
     echo "Starting doer..."
     cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
     echo "Starting validation..."
     cat validate.md success.md quality-before.txt \
       | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
       | tee validate-findings.txt
     read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
   done
   ```

   The validator's `cat` carries three files, in the order the validator was taught to expect them:
   its job, the criteria, then the baseline it is comparing against. Leave `quality-before.txt` out
   and the instruction in `validate.md` to compare against the baseline below would point at
   nothing.

   `validate.sh` guards against a missing baseline. `run.sh` needs no such guard, because it writes
   the baseline and hands it over in the same pass. The guard was never about a file existing on
   disk; it is about the validator receiving something to compare against.

   `do.sh` and `validate.sh` still run on their own, exactly as they did. The line did not replace
   them. It ordered them.

   One turn of this loop is an **iteration**: baseline, doer, validator, pause. That is the bounded
   batch of agent work between check-ins. Each `echo` names a phase within the iteration, not an
   iteration of its own. The `read` is where the line hands control back to the learner, and Ctrl-C
   at that prompt stops the line.

   With that written, the folder is the whole line:

   ```text
   factory/refactor/
     do.sh              validate.sh          run.sh
     refactor.md        validate.md          success.md
     quality-before.txt validate-findings.txt
   ```

   Three scripts, three prompts, and the two files the machines pass between them.

## Checks

From the repository root, make the new script executable and run it:

```sh
chmod +x factory/refactor/run.sh
./factory/refactor/run.sh
```

Verify by hand that:

- each machine announces itself before Pi is invoked;
- the doer runs before the validator on every pass;
- the validator reports one finding per criterion in `success.md`, not just the one it can measure;
- the loop waits for Enter before starting a second iteration; and
- `validate-findings.txt` holds the last verdict after the loop pauses.

## Pressure test

The line runs in order, and it is about to be left alone. Before that happens, look at what its
independence actually rests on.

The validator does not write to files because `validate.md` tells it not to. It holds the `bash` tool.
Every other boundary in this tutorial was drawn with `--tools` — the doer cannot run a shell because it
was never given one — and this one was drawn with a sentence.

Have the learner check rather than take it on faith. Add one line to `validate.md` asking the validator
to create `calculator/proof.txt`, run `./factory/refactor/validate.sh`, and then look for the file:

```sh
ls calculator/proof.txt
```

It is there. Delete it and remove the line again.

Nothing went wrong, because a person was reading every verdict and would have noticed. That person is
about to stop reading them. Independence that rests on a prompt is a promise the machine makes to
itself, and the next lesson replaces it with one the machine cannot break.
