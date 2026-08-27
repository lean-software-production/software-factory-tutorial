---
type: reflection
outcome: "Explain why this station needs no tools when the caller hands it all of its evidence."
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer verifies answers
  against records, confirms ask.sh has no tools and only receives filtered event lines from the
  caller, works during or after a run, and fails clearly without arguments. Accept imperfect model
  answers if the learner catches and corrects them from evidence. The why is that this is another
  station whose boundary is created by what the harness hands it.
---

## Checks

From the session workspace, after a run has finished:

```sh
./factory/ask.sh refactor "What did each iteration change, in one line each?"
```

Verify by hand that:

- the answer names things that are actually in the record, and you can find them;
- `ask.sh` runs with no tools, and does not read the calculator or any file the caller did not give
  it;
- it works on a line that has finished and on one that is halfway through, since the record is a
  file
  either way; and
- `./factory/ask.sh` with no arguments fails with its usage message.
