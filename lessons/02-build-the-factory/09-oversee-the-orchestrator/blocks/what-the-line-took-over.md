---
type: narrative
---

## What the line took over

Lesson 004 left the learner doing three jobs by hand: deciding what runs next, carrying evidence
between
stations, and judging when to stop. Walk through each one and find it in the code.

- **Deciding what runs next** is the `grep` and the `if` in 007. It is worth saying again that this
  works because the validator promises to open its response with `VERDICT:`, and the orchestrator
  recognises a shape rather than understanding a verdict.
- **Carrying evidence** is the `cat` in front of every station, the evidence block in 006, and the
  `text_of` helper in 009. No station on this line has ever gone looking for its own inputs.
- **Judging when to stop** is the two counters in 008.

Three jobs, three pieces of shell, all of them the learner's.
