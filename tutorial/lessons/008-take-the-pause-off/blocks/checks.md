---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer confirms there is no
  input wait, iterations are numbered, the ceiling stops the run, two consecutive failures stop
  early when configured to force them, passing verdicts reset the failure counter, and commits
  correspond only to passing verdicts. Accept a shortened max_iterations for testing. Follow up if
  they count total failures rather than consecutive failures; that changes the stop condition.
---

## Checks

From the session workspace:

```sh
./factory/refactor/run.sh
```

Verify by hand that:

- it never waits for input, from the first iteration to the last;
- each iteration announces its number, and the announcements bracket the phases within it;
- it stops on its own at the ceiling and says so;
- `git log --oneline` shows one commit for each passing verdict and none for the failing ones; and
- the run ends with a line naming how many iterations it took.

Then check the give-up rule without waiting for it to happen by accident. Set `max_iterations=10`,
make `success.md` demand something the doer cannot reach in one change — a criterion about the whole
codebase, not one file — and run it again. It should stop early, and say which rule stopped it.

Put `success.md` back afterwards.
