---
type: terminal-practice
outcome: "Run the behaviour checks outside the doer and read their verdict."
tutor: |-
  Guide the learner through collecting independent evidence outside the doer: git diff --
  calculator, then npm test and node scripts/quality.mjs from calculator. Success means they
  read the diff, run the two checks themselves, and can say whether the doer made at most one
  focused
  behaviour-preserving change. Accept equivalent manual diff review, but require npm test and node
  scripts/quality.mjs or a clear reason one could not run. Follow up if they ask the doer to run or
  interpret these checks; the doer must not report on its own work.
---

## Check the doer

Now collect independent evidence. Read the calculator diff, then run the checks the doer was not
allowed to run:

```sh
git diff -- calculator
(cd calculator && npm test)
(cd calculator && node scripts/quality.mjs)
```

Do not ask the doer to run or interpret these checks. The doer changed files; the evidence that says
whether the change is safe must come from outside the doer.
