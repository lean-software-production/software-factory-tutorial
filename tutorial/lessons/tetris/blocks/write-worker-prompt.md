---
type: editor-practice
outcome: Write a worker prompt that drives the factory one bounded task at a time.
path: prompt.md
tutor: |-
  Accept when `prompt.md` gives a coding agent a bounded, repeatable worker instruction with the
  two-branch plan.md mechanism.

  Without plan.md the agent should:
  - read spec.md;
  - create plan.md with exactly four similarly sized, independently checkable tasks;
  - commit that plan;
  - stop without implementing anything.

  With plan.md the agent should:
  - find the first incomplete task;
  - do exactly that task and nothing more;
  - run a relevant check if one exists;
  - require that checks must return on their own;
  - do not start the game or run interactive scaffolds, dev/watch commands, or other commands that
    might wait for input or keep running;
  - choose a non-interactive check instead when a command might wait;
  - mark the task done in plan.md before committing;
  - commit useful task work and the plan.md update together;
  - stop without starting another task.

  If no incomplete task remains, the worker should stop without an empty commit. A pass that changes
  nothing should not create an empty commit.

  The prompt must not ask the agent to start the loop script, run forever, or complete all tasks in
  a single pass.
---

## Write your worker prompt

Write `prompt.md`, the instruction each Pi pass will follow.

The prompt should describe two situations and how to handle each.

**Without `plan.md`:** Read `spec.md`, create `plan.md` with exactly four similarly sized,
independently checkable tasks, commit it, and stop. Do not start implementing anything in this
first pass.

**With `plan.md`:** Find the first task that is not yet marked done. Do exactly that task and
nothing else. Run a relevant check if one exists, but checks must return on their own. Do not start
the game, interactive scaffolds, dev/watch commands, or any command that might wait for input or
keep running as a check; choose a non-interactive check instead.

Mark the task done in `plan.md` before committing. Commit the useful task work and the `plan.md`
update together, then stop. If no incomplete task remains, stop without an empty commit. If nothing
has changed, do not create an empty commit.

Use plain language. Do not ask the worker to run the loop script, to complete all tasks in one
pass, or to run forever.
