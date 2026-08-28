---
durationMinutes: 10
blocks:
  - run-simple-pi-prompt
  - run-supplied-command
  - change-job
  - reflection
---

# Run a headless agent

We'll start with the first building block of a software factory: an agent you call from the command-line that receives a job, runs it, and exits.

This is an agent working in "batch" or "headless" or "non-interactive" mode. We're used to working with agents where they chat back and forth with us, but this is a single exchange or "turn":

* we pass the agent a prompt, describing the job to be done
* the agent does its best to fulfill our request
* the agent exits, printing some response to the console

Most command-line based coding agents give you this affordance:

```sh
claude -p "What is the capital of France?"

codex exec "What is the capital of France?"

agy -p "What is the capital of France?"

pi -p "What is the capital of France?"
```

Here's [Claude's docs](https://code.claude.com/docs/en/headless), the [Codex exec CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-exec), the [Google AntiGravity documentation for headless mode](https://antigravity.google/docs/cli/headless/#run-a-single-prompt), and the [Pi coding agent's print mode docs](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#modes).

For this tutorial we'll use Pi, because as an independent open-source project it allows us to choose
a model from any provider.