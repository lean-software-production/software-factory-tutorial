---
type: terminal-practice
tutor: |-
  Guide the learner through running the completed factory in the embedded terminal and inspecting
  files rather than building new ones. Success means they can point to factory/refactor/run.sh as
  the orchestrator, factory/ as the factory, refactor/ as the assembly line, the prompt/script pairs
  as stations, and themselves as operator, then map routing, evidence carrying, and stopping back to
  specific shell code. Accept answers in the learner's own words if they distinguish station
  decisions from orchestrator decisions. Clue with the directory tree when terminology gets fuzzy.
  The point is to name the mechanism after it exists and be precise about which judgements remain
  human.
---

## Implementation order

There is nothing to build. Start the line and watcher in the background, then ask about that run:

```sh
./factory/refactor/run.sh > .tmp/refactor-run.log 2>&1 &
./factory/watch.sh refactor > .tmp/refactor-watch.log 2>&1 &
./factory/ask.sh refactor "What happened in this run?"
```
