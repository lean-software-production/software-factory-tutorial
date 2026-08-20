---
durationMinutes: 10
outcomes:
  - Run a Pi agent headlessly with a supplied job.
  - Change the job while leaving the Pi invocation intact.
  - Identify the job and harness in the command.
  - State why the command exits rather than opening a conversation.
  - State what the listed read-only tools prevent the agent from doing.
blocks:
  - orientation
  - run-supplied-command
  - change-job
  - reflection
  - transition
---

# Run an agent headlessly

Learn the first building block of a software factory: an agent you call from the command-line
that receives a job, runs it, and exits.
