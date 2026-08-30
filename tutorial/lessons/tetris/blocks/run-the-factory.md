---
type: terminal-practice
outcome: Run the bounded factory and confirm all five passes completed.
tutor: |-
  Accept when the learner runs the bounded loop from this lesson workspace and the evidence shows
  all five pass boundaries: Pass 1/5 started, Pass 2/5 started, Pass 3/5 started, Pass 4/5
  started, Pass 5/5 started, and the bounded script returned to the prompt.

  Reject evidence for fewer than five passes, commands that start an unbounded loop or watch mode,
  or commands that bypass the learner's `ralph.sh`.

  Do not require a finished or working Tetris game or any particular implementation. The terminal
  acceptance criterion is only that all five passes ran and the script returned.

  Guidance for the interactive-command hang: if the learner reports that a pass appears stuck and
  the terminal is not returning, advise them to check whether the worker is waiting for input (some
  models prompt interactively when no session context is present). Suggest they interrupt with
  Ctrl-C, confirm `pi -p < prompt.md` in their `ralph.sh` reads the prompt from stdin rather than
  waiting interactively, and try again.
---

## Run the factory

Run your tiny factory:

```sh
bash ralph.sh
```

Watch what changes. The first pass should create `plan.md`. Later passes should complete tasks one
at a time. You may get partial code, a failing check, or a commit. Any of those is enough for this
first taste.

If a pass appears to hang without printing output, it may be waiting for interactive input. Check
that `ralph.sh` uses `pi -p < prompt.md` rather than `pi -p` without a redirect, then interrupt
with Ctrl-C and try again.

When it returns to the prompt, inspect what happened:

```sh
ls
git log --oneline --max-count=6
```
