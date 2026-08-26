---
type: reflection
tutor: |-
  The correct answer here revolves around these points:

  1) an existing agent session can be biassed by the work it's just done and 
     will not be good at checking it's own work
  2) we can use diffent model families to validate work from the model that does the work
  3) we avoid context rot which happens when the agent's context window gets full
---

## Separate agents

Each step of a factory tends to use a new agent. There are subtle exceptions to this,
as some factory steps are deterministic instead of using an agent, and sometimes
we do want an agent to be aware of previous session history.

Normally though, we keep them separate.

```mermaid
flowchart LR
    A[Plan] --> B[Work]
    B --> C[Validate]
    C --> A
```

If you think about our three agentic steps here in this factory, why do you think it's helpful to have one agent do the work, and a different one validate that work?
