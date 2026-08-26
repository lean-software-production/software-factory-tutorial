---
type: narrative
---

## A factory is a loop you can leave running

A seed says what you want. The harness turns that intent into a repeatable process: it
asks agents to plan and work, runs validation, and decides whether the next step is to
fix the result, plan more work, or stop.

The important part is not that an LLM produced an answer. It is that the harness checks
that answer against evidence. A separate validator can catch work the agent that made it
has missed, and a failed check gives the next agent a concrete reason to try again.

That makes a factory different from a long conversation in a REPL. In a REPL, you stay
in the loop, supplying direction and judging each response. Building a factory takes more
up-front work: you must describe both the outcome and how to validate it. Once you have,
the harness can run the loop autonomously and reliably apply it to larger or repeated
jobs.

In the rest of this tutorial, you will build a small factory yourself. You will write its
seed, harness, and validation steps, then see how those parts turn an agent's uncertain
work into a process that can improve its own output.
