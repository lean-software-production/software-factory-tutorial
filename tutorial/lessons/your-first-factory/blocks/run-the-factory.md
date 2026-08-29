---
type: terminal-practice
outcome: Run the bounded factory once and inspect what its two Pi passes produced.
tutor: |-
  Accept when the learner runs the bounded loop from this lesson workspace, normally with
  `bash ralph.sh`, and the evidence shows all three things: pass 1 started, pass 2 started, and the
  bounded script returned to the prompt.

  Reject evidence for more than two Pi passes, commands that start an unbounded loop or watch mode,
  and commands that bypass the learner's `ralph.sh`. It is fine if the crude worker only creates a
  first plan or partial calculator.
---

## Run the factory

Run your tiny factory:

```sh
bash ralph.sh
```

Watch what changes. You may get a plan, a first implementation, a failing check, or a commit.
Any of those is enough for this first taste. The point is not that two passes make a good
factory; the point is that a short script can repeatedly hand the same job to an agent and then
stop.

When it returns to the prompt, inspect the files if you want:

```sh
ls
git status --short
git log --oneline --max-count=3
```
