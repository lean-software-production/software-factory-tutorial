# Build a validator

Give a second agent one job: say whether the doer's change was safe.

## Key concept

A **validator** is the agent that verifies the job was done satisfactorily. It is given the work and
the criteria, and reports what is wrong, missing, or unsupported. Because it did not write the
change, it has nothing to defend.

Its boundary is the mirror image of the doer's. The doer could edit and could not run anything; the
validator can run things and cannot edit. That is not a detail — an agent that both makes a change
and reports on it is reporting on itself.

This validator is deliberately simple. It knows one number.

## Implementation order

Keep `factory/refactor.md` and `factory/refactor-do.sh` from the previous lesson. Build this lesson
in this order:

1. **Write the validator prompt.** Create `factory/refactor-validate.md`. Its job to be done is one
   sentence: was the change a single refactoring, and did it improve
   `node scripts/quality.mjs` against the recorded baseline? Tell it to read the working-tree diff
   in `calculator/`, run `node scripts/quality.mjs`, and compare the result with
   `../factory/refactor-quality-before.txt`. It must not modify any file, and it must not run shell
   commands that modify files.

   Require this response format:

   ```text
   VERDICT: PASS

   EVIDENCE:
   - <what you ran, and what it reported>
   ```

   The first non-empty line must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.

2. **Invoke the validator.** Create `factory/refactor-validate.sh`:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   if [ ! -f refactor-quality-before.txt ]; then
     echo "No quality baseline. Run ./refactor-do.sh first." >&2
     exit 1
   fi
   echo "Starting validation..."
   cat refactor-validate.md \
     | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
     | tee refactor-validate-findings.txt
   ```

   The validator gets `bash` so it can run the quality check, and no `edit` or `write` so it cannot
   repair what it finds. It stops rather than invent a comparison when there is no baseline. Its
   findings go to the terminal and to a file, because the next lesson needs them.

## Advanced: substitute another validator

Pi is the default validator, but Claude Code or Codex may take this role when configured for
non-interactive, read-only work with permission to run the checks. Its access must differ from the
doer's: it may inspect the calculator and run validation commands, but it must not edit files. Do
not assume another CLI's default sandbox or permission model provides that boundary.

## Checks

From the repository root:

```sh
./factory/refactor-do.sh
./factory/refactor-validate.sh
```

Verify by hand that the validator:

- announces itself before Pi is invoked;
- does not edit any file in `calculator/`;
- returns exactly one `PASS` or `FAIL` verdict on its first non-empty line; and
- quotes what it actually ran, rather than asserting a conclusion.

Then run `./factory/refactor-validate.sh` on its own, without a preceding doer turn, and confirm it
refuses rather than reporting on a stale baseline.

## Pressure test

This validator knows one number. Ask it whether the change revealed intention, or removed
duplication, and it has nothing to say — you never told it what good looks like. Hold that thought;
it is what Part 2 answers.

For now there is a more immediate gap. The validator found something, and nothing happened. Nobody
told the doer.
