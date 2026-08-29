---
type: editor-practice
outcome: Write a worker prompt that tells Pi how to advance the spec one step at a time.
path: prompt.md
tutor: |-
  Accept when `prompt.md` gives a coding agent a bounded, repeatable worker instruction.

  It should tell the agent to:
  - read `spec.md`;
  - create or update a small `plan.md` if needed;
  - pick one next task and do it;
  - run a relevant check if one exists;
  - commit useful work to the session repository;
  - update the plan before stopping.

  It should not tell the agent to run forever or recursively start the loop script.
---

## Write your worker prompt

Now write `prompt.md`, the instruction each Pi pass will follow.

Use plain language. For example, tell the worker to read `spec.md`, maintain `plan.md`, choose one
next task, make the change, run a useful check if there is one, commit the result, and update the
plan before it stops.

Do not ask the worker to run forever. The shell script in the next step will decide how many passes
happen.
