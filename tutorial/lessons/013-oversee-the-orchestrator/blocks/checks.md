---
type: reflection
outcome: "Explain what judgements the factory still cannot make for itself."
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer names run.sh as
  orchestrator and maps its five jobs to code, says factory-level scripts would work with another
  line while refactor/run.sh is line-specific, identifies ask.sh as the no-tools station, and
  explains repeated failures as either unmet criteria or missing evidence. Accept thoughtful
  disagreement on terms only if they tie it back to files. The point is to leave with an honest
  account of what remains operator judgement.
---

## Checks

You should be able to answer these from what you have built, in your own words:

- Which file is the orchestrator, and which of its lines does each of the five orchestrator jobs?
- Which parts of `factory/` would still work if a second line appeared tomorrow, and which would
  not?
- Where would a second line go, and what would it need of its own?
- Which station on this line has no tools at all, and why does that not limit it?
- Given a `[FAIL]` on the same criterion in five consecutive iterations, what are the two
  explanations,
  and how would you tell them apart?
- What is the most expensive thing this line could do while you were not watching, and what in the
  factory would tell you it had happened?
