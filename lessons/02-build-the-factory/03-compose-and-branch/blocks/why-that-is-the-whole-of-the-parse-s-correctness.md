---
type: narrative
---

## Why that `^` is the whole of the parse's correctness

Without it the pattern matches a verdict string anywhere on a line, including inside a sentence
about
verdicts. The validator is a model being asked to justify itself, and a model justifying itself
quotes
the rules it was given. "The verdict must be `VERDICT: PASS` or `VERDICT: FAIL`, and mine is:" is an
entirely ordinary thing for it to write above its actual answer — and an unanchored `grep` would
read
`PASS` out of that sentence and skip the repair the file below it was asking for. The line would
carry
on refactoring on top of a change the validator had just failed, having been told so in writing.
Worse,
it would commit it.

Anchored, the pattern can only match a line that opens with `VERDICT:`, so prose about verdicts is
invisible to it however the validator phrases its reasoning. `-m1` then stops at the first such
line,
and `-o` trims it to the verdict itself.

Be exact about `-m1`, because it is easy to read as more than it is: it stops after the first
matching
**line**, not the first match. With `-o`, a single line carrying two verdicts prints both, and
`$verdict` becomes a two-line string that equals neither `VERDICT: PASS` nor `VERDICT: FAIL` — which
sends it down the `else` arm and commits. The anchor is what makes that unreachable in practice,
since
a line can only open with `VERDICT:` once. Both halves of the pattern are load-bearing, and neither
covers for the other.

Be clear about what that rests on, because it is this lesson's real subject. The anchor works
because
lesson 005 told the validator to open its response with `VERDICT:` on the first non-empty line, and
for
no other reason. The orchestrator does not understand the verdict; it recognises a shape, and the
shape
is a promise the validator makes and could break. Every branch in every line the learner builds
after
this one will rest on some agreement of that kind between a station that writes and a station that
reads.

**Then look at the commit station in that light.** Its output goes straight into `git commit -F`. If
that station opens with "Here's the commit message:", the sentence is now in the repository's
history.
Same species of promise, equally load-bearing, and defended by nothing at all — there is no anchor
to
save it. Unlike a misrouted verdict, which the next iteration overwrites, this failure is permanent
and
visible in `git log` for as long as the repository exists.
