---
type: narrative
---

## Conclusion

A software factory gives agents a clear job and a way to check their work:

- The seed describes the outcome you want.
- The harness runs a repeatable loop: plan, work, validate, then fix, continue, or stop.
- Separate agents can do the work and validate it, so the check is less likely to repeat
  the worker's mistakes.
- Validation turns an uncertain answer into evidence that the result meets your needs.

That differs from working in a REPL, where you stay in a continuous conversation and
judge each response yourself. A factory takes more preparation: you must describe both
the outcome and how to validate it. In return, it can run autonomously on larger or
repeated jobs.

Next, you will build a small factory: its seed, harness, and validation steps.
