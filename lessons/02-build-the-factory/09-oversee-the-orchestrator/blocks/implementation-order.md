---
type: terminal-practice
tutor: |-
  Guide the learner through running the completed factory from three terminals and inspecting the
  files rather than building new ones. Success means they can point to factory/refactor/run.sh as
  the orchestrator, factory/ as the factory, refactor/ as the assembly line, the prompt/script pairs
  as stations, and themselves as operator, then map routing, evidence carrying, and stopping back to
  specific shell code. Accept answers in the learner's own words if they distinguish station
  decisions from orchestrator decisions. Clue with the directory tree when terminology gets fuzzy.
  The point is to name the mechanism after it exists and be precise about which judgements remain
  human.
---

## Implementation order

There is nothing to build. Run the whole thing once, from three terminals, and then work through
what
follows.

```sh
./factory/refactor/run.sh
./factory/watch.sh refactor
./factory/ask.sh refactor "What happened in this run?"
```
