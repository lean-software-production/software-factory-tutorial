---
type: terminal-practice
tutor: |-
  Guide the learner through adding the evidence-gathering block to validate.sh and run.sh, removing
  bash from validator Pi invocations, and rewriting validate.md to judge only labelled evidence
  appended by the harness. Success means .tmp/evidence.txt contains the QUALITY BEFORE, QUALITY NOW,
  TESTS, and WORKING DIFF sections, validation still emits a verdict, and asking the validator to
  create calculator/proof.txt does not create the file. Accept equivalent labels if they distinguish
  before from now and include tests plus calculator-only diff. If stuck, point to git diff -- . and
  || true as load-bearing details. The point is that the validator cannot modify work because the
  capability to run commands is gone, while the harness now owns evidence selection.
---

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

   `git diff -- .` rather than `git diff`, because `git diff` on its own reports the whole
   repository
   whatever directory it runs in, and the learner's own `factory/` work would otherwise be swept
   into
   the validator's context. The scripts and prompts in `factory/` are tracked, so that pathspec is
   the
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

   `.tmp/quality-before.txt` no longer goes to the validator directly — it goes into
   `.tmp/evidence.txt`, under a
   label, along with everything else.

3. **Rewrite the validator's prompt.** `validate.md` currently instructs the validator to read the
   diff, run the quality script, and compare. It can do none of those things now. Replace those
   instructions with the truth: the evidence arrives appended below, in labelled sections, and its
   job
   is to read it and report against `success.md`.

   Everything else about the prompt stays. Same response format, same requirement that
   `VERDICT: PASS` or `VERDICT: FAIL` is the first non-empty line, same one finding per criterion.

   Delete the sentence forbidding file-modifying shell commands. It is no longer doing any work, and
   leaving it in would teach the learner that prohibitions are how boundaries are drawn.
