---
type: terminal-practice
tutor: |-
  Guide the learner through writing factory/refactor-validate.md and factory/refactor-validate.sh,
  then running chmod, ./factory/refactor-do.sh, and ./factory/refactor-validate.sh. Success means
  the validator refuses when .tmp/refactor-quality-before.txt is absent, runs from calculator with
  read/grep/find/ls/bash and no edit/write tools, tees findings to
  .tmp/refactor-validate-findings.txt, and starts with VERDICT: PASS or VERDICT: FAIL. Accept
  validator wording that quotes actual evidence and preserves the required first line. Clue toward
  the baseline guard and tee if the next lesson would have no findings to carry. The point is to
  separate the station that changes files from the station that judges evidence.
---

## Implementation order

Keep `factory/refactor.md` and `factory/refactor-do.sh` from the previous lesson. Build this lesson
in this order:

1. **Write the validator prompt.** Create `factory/refactor-validate.md`. Its job to be done is one
   sentence: was the change a single refactoring, and did it reduce what
   `node scripts/quality.mjs` reports against the recorded baseline? Tell it to read the
   working-tree
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

   Notice that the script concatenates the baseline onto the prompt rather than telling the
   validator
   where to find it. The validator never reaches outside `calculator/`; the harness carries the
   evidence to it, which is the same deterministic code around a model call you wrote in the
   previous
   lesson.
