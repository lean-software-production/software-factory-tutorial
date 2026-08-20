---
durationMinutes: 25
outcomes:
  - Write the doer prompt that asks for one behaviour-preserving calculator refactoring.
  - Create a doer script that records a quality baseline and invokes Pi with edit tools, not shell.
  - Run the doer once, then review its diff and run the checks outside the doer.
  - Explain why the doer boundary keeps evidence generation outside the doer.
blocks:
  - key-concept
  - write-doer-prompt
  - write-doer-harness
  - run-doer
  - check-the-doer
  - alternatives-choose-another-doer
  - checks
  - pressure-test
---

# Build a doer

Give an agent a job that changes the calculator, and check its work yourself.
