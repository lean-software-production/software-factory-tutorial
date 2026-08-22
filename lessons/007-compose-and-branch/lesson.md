---
durationMinutes: 40
outcomes:
  - Add a repair station that responds to validator findings without starting a new refactoring.
  - Add a commit-message station that writes only the message while git performs the commit.
  - Branch run.sh on an anchored validator verdict and route failures to repair and passes to commit.
  - Verify that unreadable verdicts fail closed rather than committing unchecked work.
blocks:
  - key-concept
  - implementation-order
  - why-that-is-the-whole-of-the-parse-s-correctness
  - why-an-agent-writes-the-message-and-a-script-makes-the-commit
  - what-the-branch-buys-beyond-routing
  - checks
  - pressure-test
---

# Compose stations, and branch

Read the verdict in Bash, send a failed one to repair, and give a passing one somewhere to go.
