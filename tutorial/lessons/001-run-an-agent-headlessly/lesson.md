---
durationMinutes: 10
outcomes:
  - Run a Pi agent headlessly with a supplied job.
  - Change the job while leaving the Pi invocation intact.
  - Identify the job and harness in the command.
  - State why the command exits rather than opening a conversation.
  - State what the listed read-only tools prevent the agent from doing.
blocks:
  - run-supplied-command
  - change-job
  - reflection
  - transition
---

# Run a headless agent

We'll start with the first building block of a software factory: an agent you call from the command-line that receives a job, runs it, and exits.

This is an agent working in "batch" or "headless" or "non-interactive" mode. We're used to working with agents where they chat back and forth with us, but this is a single exchange or "turn":

* we pass the agent a prompt, describing the job to be done
* the agent does its best to fulfill our request
* the agent exits, printing some response to the console

Most command-line based agent harnesses give you this affordance:

```sh
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

Here's [Claude's docs](https://code.claude.com/docs/en/headless).

You will use the tutor's embedded terminal. First, you will run an agent with a supplied job. Then you will change only that job and observe what stays the same.

An **agent** is a harness with a job to be done. The **harness** is ordinary software: it prepares the input, calls a model, and handles what comes back. The **job to be done** is what you hand it.
