---
type: narrative
---

## Key concept

Nothing is built in this lesson. Everything it names is already on disk.

Lesson 005 made the same move on a smaller scale: put the doer and the validator in one folder, run
them in a fixed order, and only then take the name. This is that move applied to the whole of Part
2,
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
jobs: starting a line, handing each station its inputs, choosing what runs next where the graph
branches, handling failures, and deciding when the line is finished. The learner wrote every one of
them. The branch arrived in 007, the ending in 008, and the rest has been there since 005.

**The factory is `factory/`** — the software containing the line and the orchestrator that manages
it,
which the lexicon calls the unit you build, deploy and operate. The three scripts above the line are
not what make it a factory; they are the third verb. Each takes a line's name as an argument and
would
work unchanged on a second line, which is the only reason it is honest to call a folder with one
line
in it a factory at all.

**The learner is the operator.** That word has not been used before now, because until this point it
would have been a description of somebody doing the work by hand.
