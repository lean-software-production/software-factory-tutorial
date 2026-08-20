---
durationMinutes: 30
outcomes:
  - Move evidence gathering out of the validator model and into the harness scripts.
  - Remove bash from the validator invocation while preserving its ability to judge labelled evidence.
  - Rewrite the validator prompt so it reports only from evidence appended by the harness.
  - Explain the guarantee and limitation created by closing the validator evidence set.
blocks:
  - key-concept
  - implementation-order
  - what-this-costs
  - advanced-a-boundary-that-inspects-rather-than-removes
  - checks
  - pressure-test
---

# Put the validator on a read-only harness

Take the `bash` tool away from the validator, and carry its evidence to it instead.
