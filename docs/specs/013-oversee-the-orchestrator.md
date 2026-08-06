# Oversee the orchestrator

Name what has been built, and be exact about what is left.

## Key concept

Nothing is built in this lesson. Everything it names is already on disk.

Lesson 005 made the same move on a smaller scale: put the doer and the validator in one folder, run
them in a fixed order, and only then take the name. This is that move applied to the whole of Part 2,
and it works for the same reason — the learner has something to point at.

```text
factory/                    ← the factory
  watch.sh  ask.sh  steer.sh    ← how it is operated
  refactor/                 ← an assembly line
    run.sh                  ← the orchestrator
    do.sh  validate.sh
    refactor.md  validate.md  repair.md  commit.md  success.md
    .tmp/quality-before.txt  .tmp/evidence.txt  .tmp/validate-findings.txt
    .tmp/events/                 ← the record
```

**The orchestrator is `run.sh`, and it has been since lesson 007.** The lexicon gives the role five
jobs: starting a line, handing each machine its inputs, choosing what runs next where the graph
branches, handling failures, and deciding when the line is finished. The learner wrote every one of
them. The branch arrived in 007, the ending in 008, and the rest has been there since 005.

**The factory is `factory/`** — the software containing the line and the orchestrator that manages it,
which the lexicon calls the unit you build, deploy and operate. The three scripts above the line are
not what make it a factory; they are the third verb. Each takes a line's name as an argument and would
work unchanged on a second line, which is the only reason it is honest to call a folder with one line
in it a factory at all.

**The learner is the operator.** That word has not been used before now, because until this point it
would have been a description of somebody doing the work by hand.

## Implementation order

There is nothing to build. Run the whole thing once, from three terminals, and then work through what
follows.

```sh
./factory/refactor/run.sh
./factory/watch.sh refactor
./factory/ask.sh refactor "What happened in this run?"
```

## What the line took over

Lesson 004 left the learner doing three jobs by hand: deciding what runs next, carrying evidence between
machines, and judging when to stop. Walk through each one and find it in the code.

- **Deciding what runs next** is the `grep` and the `if` in 007. It is worth saying again that this
  works because the validator promises to open its response with `VERDICT:`, and the orchestrator
  recognises a shape rather than understanding a verdict.
- **Carrying evidence** is the `cat` in front of every station, the evidence block in 006, and the
  `text_of` helper in 009. No machine on this line has ever gone looking for its own inputs.
- **Judging when to stop** is the two counters in 008.

Three jobs, three pieces of shell, all of them the learner's.

## What is left

This is the lesson. Take it slowly, because every item is a judgement and every one of them is still
the learner's.

**It cannot tell whether the criteria are right.** `success.md` is the one thing on this line that
nothing ever questions. And lesson 006 made this sharper than it looks: closing the validator's
evidence set bought a boundary that holds without being asked, and the price was that the evidence has
to be anticipated. A criterion nobody captured evidence for reports `[FAIL]` — the same `[FAIL]` a
criterion the doer has simply not met yet would report. Nothing in the record distinguishes
*unreachable* from *not yet reached*. The line's response to both is the same: repair, and try again.

**It cannot notice it is going backwards.** Every iteration is judged against the criteria, and no
iteration is judged against the one before it. A repair that reintroduces the duplication the last
refactoring removed reads as an ordinary failing pass, and the line will oscillate between two states
for as long as it has iterations left.

**It cannot tell whether a repair worked.** A repair is not validated before the next iteration begins,
so its verdict is folded into the following refactoring's. Nothing here ever reports on a repair alone.

**It cannot decide the run was not worth it.** The cost is in the record and `ask.sh` will read it out,
but no number in `success.md` says what a criterion is worth. Comparing what the line spent with what
it achieved is not a comparison the line can make, because only one of those two things is written
down.

**It cannot be told any of this.** 012 gave the learner a channel to a machine. There is no channel to
the orchestrator: its decisions are `if` statements, and the way to change its mind is to stop it and
edit the file. That is not a defect to be fixed — it is what it means for routing to be deterministic —
but it is worth knowing which of the two things in front of them can be argued with.

## Checks

The learner should be able to answer these from what they have built, in their own words:

- Which file is the orchestrator, and which of its lines does each of the five orchestrator jobs?
- Which parts of `factory/` would still work if a second line appeared tomorrow, and which would not?
- Where would a second line go, and what would it need of its own?
- Which machine on this line has no tools at all, and why does that not limit it?
- Given a `[FAIL]` on the same criterion in five consecutive iterations, what are the two explanations,
  and how would they tell them apart?
- What is the most expensive thing this line could do while they were not watching, and what in the
  factory would tell them it had happened?

## Pressure test

Set `max_iterations=50` and let the line run.

It will do exactly what it was built to do, fifty times, and stop. Somewhere in there it may fix
something real, and somewhere in there it may spend twenty iterations circling a criterion nobody can
gather evidence for, repairing towards a target it cannot reach. Both look identical from inside the
line: a verdict, a repair, a fresh refactoring, a verdict.

The difference between those two runs is not in the record, and no machine here can find it.

That is the job the learner is left with, and it is not a smaller job than the one they started with.
The line has taken over the mechanical part of the work — routing it, carrying it, recording it,
knowing when to stop — and left the part that requires knowing what the work is for.
