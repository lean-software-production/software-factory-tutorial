---
type: narrative
---

## Key concept

The `read` at the bottom of the loop is the last thing on this line that requires a person. Delete
it
and the line runs until something stops it — which means something has to.

That something is `run.sh`, and it is not taking on a new role. The lexicon's orchestrator is
responsible for "starting a line, handing each station its inputs, choosing what runs next where the
graph branches, handling failures and retries, and **deciding when the line is finished**." The
previous lesson gave `run.sh` the branch. This lesson gives it the ending, and after it the
orchestrator is doing the whole of its job.

This is also the first time on this line that anything is remembered from one iteration to the next.
Every station so far has been handed its inputs and run to completion with no memory of the turn
before; the criteria outlive an iteration, but nothing else does. A stop condition cannot work that
way. It has to count.
