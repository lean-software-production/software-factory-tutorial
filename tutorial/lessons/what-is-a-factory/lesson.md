---
durationMinutes: 10
outcomes:
  - Explain why validation is so important
  - Describe the difference between the agent, the harness and the seed
  - Explain why separate agents are used for each stage
  - Reflect on the difference between working in a REPL and using a factory
blocks:
  - importance-of-validation
  - describe-components
  - separate-agents
  - factory-vs-repl
  - conclusion
---

# What makes something a software factory?

A software factory combines multiple agents working together,
with some kind of feedback or validation loop, allowing them
to work autonomously towards an outcome you have described.

```mermaid
flowchart LR
    O[Seed] --> A[Plan]
    A --> B[Work]
    B --> C[Validate]
    C --> A
    C --> D[Done]
```

That description of the outcome you want is the _seed_: the raw materials going into the factory. It could be a detailed, formal specification, or a vague idea. 

An agent then plans some work towards that outcome, another agent picks up and does some of that work, and another agent validates the work when it's complete.

If the work is found to be invalid, we loop back to fix it. If the work is valid, we might loop back to plan some more work, or we might be done. The logic to run this loop is deterministic code, delegating to LLM agents at each step.

Many factories build out this pattern into much more complex flows, but that validation loop is the key ingredient.

Contrast this with the way you might work with a coding agent today, where you have a
continuous back-and-forth conversation with it, directing it at every turn.
