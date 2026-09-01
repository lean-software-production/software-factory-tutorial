---
durationMinutes: 10
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
to work autonomously towards a desired outcome.

Here's an example of a simple factory:

```mermaid
flowchart LR
    O[🌱 Seed] --> A[🤖 Plan]
    A --> B[🤖 Work]
    B --> C[🤖 Validate]
    C --> A
    C --> D[✅ Done]
```

The _seed_ is the raw materials going into the factory. What kind of seed you give it depends on what the factory does: It could a detailed specification, a list of PRs to review, the URL of a codebase you want to port to anther language, etc.

An agent then plans some work towards that outcome, another agent picks up and does some of that work, and another agent validates the work when it's complete.

If the work is found to be invalid, we loop back to fix it. If the work is valid, we might loop back to plan some more work, or we might be done. The logic to run this loop is deterministic code, delegating to LLM agents at each step.

Many factories build out this pattern into much more complex flows, but that validation loop is the key ingredient.

Contrast this with the way you might work with a coding agent today, where you have a
continuous back-and-forth conversation with it, directing it at every turn.
