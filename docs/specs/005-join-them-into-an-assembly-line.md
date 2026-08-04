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
   git mv factory/refactor-do.sh       factory/refactor/do.sh
   git mv factory/refactor-validate.sh factory/refactor/validate.sh
   git mv factory/refactor.md          factory/refactor/refactor.md
   git mv factory/refactor-validate.md factory/refactor/validate.md
   ```

   The `refactor-` prefixes drop because the folder now carries the line's name. Two references
   inside the scripts still use the old names, so update them: `refactor-validate.md` becomes
   `validate.md`, and `refactor-validate-findings.txt` becomes `validate-findings.txt`.

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
   criteria any more. Both defer to `success.md`, which arrives appended to the prompt when the line
   runs — the same trick lesson 003 used to hand the validator its baseline. Neither prompt names a
   path to go and fetch, because both machines run from `calculator/` and neither needs to reach
   outside it.

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
     echo "Starting doer iteration..."
     cat refactor.md success.md | (cd ../../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
     echo "Starting validation..."
     cat validate.md success.md \
       | (cd ../../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
       | tee validate-findings.txt
     read -r -p "Press Enter for the next iteration, or Ctrl-C to stop. "
   done
   ```

   The line records its own baseline at the top of every pass, so it never needs the guard that
   `validate.sh` has: it cannot reach the validator without having written `quality-before.txt` a
   moment earlier. `validate.sh` still needs its guard, because it can still be run on its own.

   Which is the other thing to notice: `do.sh` and `validate.sh` are untouched and still work
   exactly as they did. The line did not replace them. It ordered them.

   One turn of this loop is an **iteration** — a bounded batch of agent work between check-ins. The
   `read` is where the line hands control back to the learner, and Ctrl-C at that prompt stops the
   line.

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

The line runs in order, and it stops for the learner between iterations. What it does not do is
anything at all with what the validator found.

Watch a `FAIL` go past and then press Enter. The next iteration is identical to the one that would
have followed a `PASS`: same prompt, same baseline, same job. The findings were written to a file and
read by nobody.

That is lesson 004's copy-paste — the step the learner did with their own hands — still undone. The
next lesson gives it to the line.
