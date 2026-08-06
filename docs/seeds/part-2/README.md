# Part 2 seed

What lessons 002 to 004 leave in `factory/`, for a learner who starts at Part 2 instead of building
it. "Start at Part 2" on the tutorial's opening screen copies these files into `factory/` and marks
Part 1 skipped; lesson 005 then finds what it expects to move.

Keep this in step with the lessons that teach these files. `seed.test.ts` reads lesson 005's `mv`
commands and fails if this directory does not supply every source path they name, which catches a
rename but not a change of content — if you change what lesson 002, 003 or 004 has the learner write,
change it here too.

`refactor-quality-before.txt` is a recorded baseline and the one file here that goes stale without
breaking anything: `do.sh` overwrites it on the first run, and lesson 005's `run.sh` records it again
each time round.

This directory is not the learner's work and is never written to. It ships in the repository, unlike
`factory/`, which is gitignored.
