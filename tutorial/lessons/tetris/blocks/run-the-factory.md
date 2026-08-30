---
type: terminal-practice
outcome: Run the bounded factory and confirm all five passes completed.
tutor: |-
  Accept when the learner runs the bounded loop from this lesson workspace and the evidence shows
  every explicit boundary and shows the script returned to the prompt: Pass 1/5: starting,
  Pass 1/5: done,
  Pass 2/5: starting, Pass 2/5: done, Pass 3/5: starting, Pass 3/5: done, Pass 4/5: starting,
  Pass 4/5: done, Pass 5/5: starting, and Pass 5/5: done.

  Reject evidence for fewer than five complete passes, commands that start an unbounded loop or
  watch mode, commands that bypass the learner's `ralph.sh`, or output that has not returned to the
  prompt.

  Do not require a finished or working Tetris game or any particular implementation. The terminal
  acceptance criterion is only that all five passes completed and the script returned.
---

## Run the factory

Run your tiny factory:

```sh
bash ralph.sh
```

Watch what changes. The first pass should create `plan.md`. Later passes should complete tasks one
at a time. You may get partial code, a failing check, or a commit. Any of those is enough for this
first taste.

When it returns to the prompt, inspect what happened:

```sh
ls
git log --oneline --max-count=6
```
