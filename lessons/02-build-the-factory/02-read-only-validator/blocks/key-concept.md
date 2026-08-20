---
type: narrative
---

## Key concept

A boundary you ask for is not a boundary you own.

The previous lesson ended by proving it: the validator wrote a file because a line of `validate.md`
asked it to, and nothing in the harness objected. Every other boundary on this line is structural.
The
doer cannot run a shell command because it was never handed a shell. The validator's read-only
promise is the only one enforced by asking nicely, and it is the one the line is about to stop
supervising.

The fix is not a different tool or a different CLI. The **harness** is a different configuration of
the
same one: drop `bash` from the validator's `--tools`, and it cannot modify anything, because it
cannot
execute anything.

Which creates the obvious problem. The validator needs `node scripts/quality.mjs`, it needs the test
results, and it needs to see the diff — and it can no longer run any of them.

The answer is a move the learner has already made once. Lesson 003 did not tell the validator where
to
find the quality baseline; it concatenated the baseline onto the prompt. The same pattern, applied
to
everything the validator used to run for itself: **the harness runs the commands and appends their
output to the prompt, because the validator can no longer run them itself.**
