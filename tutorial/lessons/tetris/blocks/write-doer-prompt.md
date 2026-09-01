---
type: editor-practice
outcome: Write a Pi prompt that drives the factory one bounded task at a time.
path: prompt.md
tutor: |-
  Accept when `prompt.md` gives the following instructions:

  When there is no plan.md:
  - read spec.md;
  - create plan.md with exactly four similarly sized tasks;

  When plan.md exists:
  - find the first incomplete task;
  - do exactly that task and nothing more;
  - do not start the game or run commands that might wait for input or keep running;
  - mark the task done in plan.md

  The prompt must not ask Pi to start the loop script, run forever, or complete all tasks in a
  single pass.
---

## Review the prompt

Review `prompt.md`, the instruction each Pi pass will follow.

```mermaid
flowchart TD
    Start([One Pi pass]) --> PlanExists{Does plan.md exist?}
    PlanExists -- No --> ReadSpec[Read spec.md]
    ReadSpec --> CreatePlan[Create plan.md\nwith exactly four similar tasks]
    CreatePlan -->|implement nothing| Stop([Stop])

    PlanExists -- Yes --> FindTask{Is there an incomplete task?}
    FindTask -->|No: no work left| Stop
    FindTask -- Yes --> ImplementTask[Implement first incomplete task]
    ImplementTask --> UpdatePlan[Mark the task done in plan.md]
    UpdatePlan -->|do not start another task| Stop
```
