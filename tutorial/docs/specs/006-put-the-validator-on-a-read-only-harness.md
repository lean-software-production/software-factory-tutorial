# Put the validator on a read-only harness

Take the `bash` tool away from the validator, and carry its evidence to it instead.

## Key concept

A boundary you ask for is not a boundary you own.

The previous lesson ended by proving it: the validator wrote a file because a line of `validate.md`
asked it to, and nothing in the harness objected. Every other boundary on this line is structural. The
doer cannot run a shell command because it was never handed a shell. The validator's read-only
promise is the only one enforced by asking nicely, and it is the one the line is about to stop
supervising.

The fix is not a different tool or a different CLI. The **harness** is a different configuration of the
same one: drop `bash` from the validator's `--tools`, and it cannot modify anything, because it cannot
execute anything.

Which creates the obvious problem. The validator needs `node scripts/quality.mjs`, it needs the test
results, and it needs to see the diff — and it can no longer run any of them.

The answer is a move the learner has already made once. Lesson 003 did not tell the validator where to
find the quality baseline; it concatenated the baseline onto the prompt. The same pattern, applied to
everything the validator used to run for itself: **the harness runs the commands and appends their
output to the prompt, because the validator can no longer run them itself.**

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Gather the evidence in the harness.** Both `validate.sh` and `run.sh` need the same block, so
   write it once and understand it before copying it:

   ```sh
   echo "Gathering evidence..."
   {
     echo "=== QUALITY BEFORE (recorded before the doer ran) ==="
     cat .tmp/quality-before.txt
     echo
     echo "=== QUALITY NOW ==="
     (cd ../../calculator && node scripts/quality.mjs) || true
     echo
     echo "=== TESTS ==="
     (cd ../../calculator && npm test 2>&1) || true
     echo
     echo "=== WORKING DIFF ==="
     (cd ../../calculator && git diff -- .)
   } > .tmp/evidence.txt
   ```

   Three details are worth stopping on.

   The section headers are not decoration. Two of these blocks are quality reports, and concatenated
   without labels the validator has no way to tell which one came first. When a harness carries
   evidence, the evidence has to say what it is.

   `git diff -- .` rather than `git diff`, because `git diff` on its own reports the whole repository
   whatever directory it runs in, and the learner's own `factory/` work would otherwise be swept into
   the validator's context. The scripts and prompts in `factory/` are tracked, so that pathspec is the
   only thing keeping them out: this is a boundary drawn by the argument, not by an accident.

   `|| true` on the two commands that report findings by exiting non-zero, because `set -e` would
   otherwise end the run at exactly the moment there was something to report.

2. **Narrow the validator.** In both `validate.sh` and `run.sh`, the validator's invocation loses
   `bash` and takes one file instead of two:

   ```sh
   echo "Starting validation..."
   cat validate.md success.md .tmp/evidence.txt \
     | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \
     | tee .tmp/validate-findings.txt
   ```

   `.tmp/quality-before.txt` no longer goes to the validator directly — it goes into `.tmp/evidence.txt`, under a
   label, along with everything else.

3. **Rewrite the validator's prompt.** `validate.md` currently instructs the validator to read the
   diff, run the quality script, and compare. It can do none of those things now. Replace those
   instructions with the truth: the evidence arrives appended below, in labelled sections, and its job
   is to read it and report against `success.md`.

   Everything else about the prompt stays. Same response format, same requirement that
   `VERDICT: PASS` or `VERDICT: FAIL` is the first non-empty line, same one finding per criterion.

   Delete the sentence forbidding file-modifying shell commands. It is no longer doing any work, and
   leaving it in would teach the learner that prohibitions are how boundaries are drawn.

## What this costs

Say this out loud in the lesson, because it is the trade and not a footnote.

The validator keeps `read`, `grep`, `find` and `ls`. It can still search the calculator, open a file,
and follow a hunch. What it has lost is the ability to **run** anything nobody anticipated — a check
the script author did not think of, a filtered test run, a `git diff --stat` to see which files moved
most.

Its evidence set is now closed, and whoever writes the script decides what is in it.

That closure is the guarantee and the limitation in one, and both halves are real. The guarantee is
that the validator cannot touch the work it is judging, whatever anyone writes in its prompt. The
limitation is that a criterion in `success.md` whose evidence nobody thought to capture cannot be
investigated: the validator will either say nothing about it or invent support for it. Lesson 013
comes back to this.

## Advanced: a boundary that inspects rather than removes

Pi extensions can intercept a tool call and refuse it — `examples/extensions/confirm-destructive.ts`
in the Pi package is this shape. That would let the validator keep `bash` while a hook rejected
anything that modifies a file.

It is more machinery for a weaker guarantee. A boundary enforced by removing a capability is one you
can verify by reading the command line; a boundary enforced by inspecting each use of a capability is
only as good as the inspector. Prefer taking the tool away.

## Checks

From the tutorial root, run a doer turn and then a validation turn:

```sh
./factory/refactor/do.sh
./factory/refactor/validate.sh
```

Verify by hand that:

- the harness announces the evidence-gathering step before it happens;
- `factory/refactor/.tmp/evidence.txt` exists and contains four labelled sections;
- the verdict still opens with `VERDICT: PASS` or `VERDICT: FAIL` on its first non-empty line;
- the findings quote the output the harness gathered, rather than describing commands the validator
  claims to have run; and
- `factory/refactor/run.sh` gathers the same evidence and passes the same three files.

Then repeat the previous lesson's demonstration, which should now fail. Add a line to `validate.md`
asking the validator to create `calculator/proof.txt`, run the validator, and look:

```sh
ls calculator/proof.txt
```

There is no file, and the validator has no way to make one. Remove the line again.

## Pressure test

The line runs in order, it can be trusted not to grade its own work, and it does nothing at all with
what the validator found.

Watch a `FAIL` go past and then press Enter. The next iteration is identical to the one that would have
followed a `PASS`: same prompt, same criteria, same job. The findings were written to a file and read
by nobody.

That is lesson 004's copy-paste — the step the learner did with their own hands — still undone. The
next lesson gives it to the line.
