---
type: narrative
---

## What this costs

Say this out loud in the lesson, because it is the trade and not a footnote.

The validator keeps `read`, `grep`, `find` and `ls`. It can still search the calculator, open a
file,
and follow a hunch. What it has lost is the ability to **run** anything nobody anticipated — a check
the script author did not think of, a filtered test run, a `git diff --stat` to see which files
moved
most.

Its evidence set is now closed, and whoever writes the script decides what is in it.

That closure is the guarantee and the limitation in one, and both halves are real. The guarantee is
that the validator cannot touch the work it is judging, whatever anyone writes in its prompt. The
limitation is that a criterion in `success.md` whose evidence nobody thought to capture cannot be
investigated: the validator will either say nothing about it or invent support for it. Lesson 013
comes back to this.
