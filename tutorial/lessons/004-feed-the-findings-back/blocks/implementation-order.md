---
type: terminal-practice
tutor: |-
  Guide the learner through getting a failing verdict, appending .tmp/refactor-validate-findings.txt
  to the doer context with the displayed subshell command, and validating again. Success means they
  do not rerun refactor-do.sh for the feedback turn, because that would overwrite the baseline, and
  they can explain that only the doer context changed. Accept a hand-edited calculator or stricter
  validator as a way to create material for a FAIL. If they get a PASS every time, help them create
  a safe failure rather than skipping the cycle. The exercise exists so the learner feels the
  orchestration work before software takes it over.
---

## Implementation order

No new files. Run this cycle, in this order:

1. **Get a failing verdict.** Run `./factory/refactor-do.sh` then `./factory/refactor-validate.sh`
   until the validator reports `VERDICT: FAIL`. If everything passes, make the validator stricter,
   or hand-edit the calculator to introduce something worth reporting — a failing verdict is the
   material this lesson works with.
2. **Hand the findings back.** From the tutorial root, run the doer again with the findings
   appended to its prompt. The whole command sits inside a subshell, so you are back at the
   tutorial root when it finishes:

   ```sh command
   (cd factory \
     && cat refactor.md .tmp/refactor-validate-findings.txt \
     | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p))
   ```

   Note that this is not `refactor-do.sh`. Running the script would re-record the baseline first,
   which would throw away the "before" the findings were written against. This lesson runs the doer
   by hand precisely so that the baseline stays put.

   Nothing about the doer changed. Its job to be done is the same file it always was. The only
   difference is what else was in its context.
3. **Validate again.** You are back at the tutorial root, so run `./factory/refactor-validate.sh`
   and read the new verdict. Name what you did in this cycle that neither agent did.
