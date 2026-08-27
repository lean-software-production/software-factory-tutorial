---
type: reflection
outcome: "Explain why the doer boundary keeps evidence generation outside the doer."
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer says refactor-do.sh
  announces its phases, records a baseline in factory/.tmp, runs Pi from calculator with edit tools
  and no bash, makes at most one focused calculator change, and leaves testing and quality checks to
  the learner. Accept equivalent manual diff review, but require npm test and node
  scripts/quality.mjs or a clear reason they could not run. Follow up if they describe the doer as
  having checked its own work; the lesson is about keeping that evidence outside the doer.
---

## Checks

Before moving on, answer these checks:

- Did `refactor-do.sh` announce each step before invoking Pi?
- Did it record the baseline in `factory/.tmp/refactor-quality-before.txt`?
- Did it run Pi from `calculator/` with `read,edit,write,grep,find,ls` and no `bash` tool?
- Did the calculator diff show at most one focused change?
- Did you run `npm test` and `node scripts/quality.mjs` outside the doer?

If the doer checked its own work, the boundary moved. Put the evidence back outside the doer before
you continue.
