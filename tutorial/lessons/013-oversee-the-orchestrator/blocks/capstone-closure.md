---
type: narrative
---

## Capstone

You built a factory: one assembly line, its orchestrator, and the three scripts that let you run
it, watch it, and ask it questions from outside. Every station in `factory/refactor/` still does
exactly the job it did in Part 1, alone and by hand — this line gives each one a fixed place in a
fixed order, and somewhere to write down what happened.

That somewhere is the record: `.tmp/events/`, one JSONL file per station per iteration. `ask.sh`
reads it back in words and `watch.sh` shows it live, and neither one answers from anything but
what the run actually wrote.

You are the operator. Nothing in this factory decides whether its criteria are right, notices when
a run is going backwards, or judges whether what it spent was worth what it achieved. Those calls
are still yours, on every run.

One experiment worth trying next: write a criterion in `success.md` that no command can gather
evidence for, run the line, and watch it fail the same way an unreachable target would.
