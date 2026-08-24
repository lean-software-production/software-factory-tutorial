# Build a validator

Give a second agent one job: say whether the doer's change was safe.

## Key concept

A **validator** is the agent that verifies the job was done satisfactorily. It is given the work and
the criteria, and reports what is wrong, missing, or unsupported. Because it did not write the
change, it has nothing to defend.

Its boundary is the mirror image of the doer's. The doer could edit and could not run anything; the
validator can run things and cannot edit. That is not a detail — an agent that both makes a change
and reports on it is reporting on itself.

This validator is deliberately simple. It knows one check.

## Implementation order

Keep `factory/refactor.md` and `factory/refactor-do.sh` from the previous lesson. Build this lesson
in this order:

1. **Write the validator prompt.** Create `factory/refactor-validate.md`. Its job to be done is one
   sentence: was the change a single refactoring, and did it reduce what
   `node scripts/quality.mjs` reports against the recorded baseline? Tell it to read the working-tree
   diff in `calculator/`, run `node scripts/quality.mjs`, and compare the findings it gets with the
   baseline included below its instructions. It must not modify any file, and it must not run shell
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
   mkdir -p .tmp
   if [ ! -f .tmp/refactor-quality-before.txt ]; then
     echo "No quality baseline. Run ./refactor-do.sh first." >&2
     exit 1
   fi
   echo "Starting validation..."
   cat refactor-validate.md .tmp/refactor-quality-before.txt \
     | (cd ../calculator && pi --no-session --tools read,grep,find,ls,bash -p) \
     | tee .tmp/refactor-validate-findings.txt
   ```

   The validator gets `bash` so it can run the quality check, and no `edit` or `write` so it cannot
   repair what it finds. It stops rather than invent a comparison when there is no baseline. Its
   findings go to the terminal and to a file, because the next lesson needs them.

   Notice that the script concatenates the baseline onto the prompt rather than telling the validator
   where to find it. The validator never reaches outside `calculator/`; the harness carries the
   evidence to it, which is the same deterministic code around a model call you wrote in the previous
   lesson.

## Advanced: substitute another validator

Pi is the default validator, but Claude Code or Codex may take this role when configured for
non-interactive, read-only work with permission to run the checks. Its access must differ from the
doer's: it may inspect the calculator and run validation commands, but it must not edit files. Do
not assume another CLI's default sandbox or permission model provides that boundary.

## Checks

From the repository root, make the new script executable and run a doer turn followed by a
validation turn:

```sh
chmod +x factory/refactor-validate.sh
./factory/refactor-do.sh
./factory/refactor-validate.sh
```

Verify by hand that the validator:

- announces itself before Pi is invoked;
- does not edit any file in `calculator/`;
- returns exactly one `PASS` or `FAIL` verdict on its first non-empty line; and
- quotes what it actually ran, rather than asserting a conclusion.

Then check the guard. The run above left a baseline behind, so delete it and run the validator on its
own:

```sh
rm factory/.tmp/refactor-quality-before.txt
./factory/refactor-validate.sh
```

Confirm it refuses and exits non-zero, rather than inventing a comparison against a baseline that is
not there. Run `./factory/refactor-do.sh` again afterwards to restore one.

## Pressure test

This validator knows one check. Ask it whether the change revealed intention, or removed
duplication, and it has nothing to say — you never told it what good looks like. It can only tell you
that a linter has fewer complaints than it had before, which is not the same thing. Hold that
thought; it is what Part 2 answers.

For now there is a more immediate gap. The validator found something, and nothing happened. Nobody
told the doer.
