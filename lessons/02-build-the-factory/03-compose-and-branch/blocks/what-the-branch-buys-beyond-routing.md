---
type: narrative
---

## What the branch buys beyond routing

Three things, none of which needed a lesson of its own:

- **A verdict now has a consequence.** A `PASS` produces something durable and a `FAIL` does not,
  and
  the difference survives the terminal being closed.
- **The line gains a discardable unit of work.** Every accepted iteration is one commit, which is
  what
  makes running the line unattended survivable in the next lesson. `git log` and `git revert` are
  the
  undo the learner has not needed until now.
- **The pass case stops being empty.** Note what the `if` used to lack: an `else`. A `PASS` was the
  branch that did nothing. Now both directions of the graph go somewhere, which is what makes it
  worth
  drawing.
