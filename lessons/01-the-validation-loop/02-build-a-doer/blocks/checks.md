---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer says refactor-do.sh
  announces its phases, records a baseline in factory/.tmp, runs Pi from calculator with edit tools
  and no bash, makes at most one focused calculator change, and leaves testing and quality checks to
  the learner. Accept equivalent manual review commands, but require npm test and node
  scripts/quality.mjs or a clear reason they could not run. Follow up if they describe the doer as
  having validated its own work; the lesson is about keeping that evidence outside the doer.
---

## Checks

From the repository root, make the script executable and run it:

```sh
chmod +x factory/refactor-do.sh
./factory/refactor-do.sh
```

Then review the change yourself. Read the diff, and run the evidence the doer was not allowed to
run:

```sh
(cd calculator && npm test)
(cd calculator && node scripts/quality.mjs)
```

Do not ask the doer to run or interpret these checks.

Verify manually that `refactor-do.sh` announces each step before invoking Pi, that the doer works
only in `calculator/`, makes at most one focused change, and cannot invoke a shell tool.
