---
type: narrative
---

## Conclusion

A software factory gets agents working autonomously towards a clear goal with a way to check their work:

- The seed describes the outcome you want.
- The harness runs a loop that does work, then validates it, re-working if neccesary
- Separate agents do the work and validation, so that the validation is unbiassed

That differs from working in an agent chat "REPL", where you stay in a continuous 
conversation and validate the work by hand. A factory takes more investment: you 
must describe both the outcome and how to validate it. In return, it can run 
autonomously on larger or repeated jobs, and produce more consistent results.

Next, you will build a small factory yourself.
