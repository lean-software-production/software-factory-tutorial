---
type: reflection
outcome: "Move the Part 1 scripts and prompts into a named refactor line and agree the shared success criteria."
tutor: |-
  Accept either starting state. A learner who worked through Part 1 by hand should confirm the
  files they wrote across lessons 002 to 004; if any are missing, send them back to that lesson
  rather than forward into this one. A learner who chose "Start at Part 2" should confirm the seed
  already placed the same files. Either way, do not move on until factory/ holds all five:
  refactor.md, refactor-do.sh, refactor-validate.md, refactor-validate.sh, and
  .tmp/refactor-quality-before.txt. This lesson's first step moves them by exact name.
---

## Before you begin Part 2

Part 2 assumes a doer and a validator are already sitting in `factory/`, whichever way they got
there.

Check now, from the session workspace:

```sh
ls factory/ factory/.tmp/
```

You should see `refactor.md`, `refactor-do.sh`, `refactor-validate.md`, `refactor-validate.sh`,
and `.tmp/refactor-quality-before.txt`.

- If you built Part 1 by hand, these are the files you wrote across lessons 002 to 004.
- If you chose "Start at Part 2", the tutorial seeded them for you before this lesson began.

Either route is fine. What matters is that all five files are there before you go on, because the
first step of this lesson moves each one by its exact name.
