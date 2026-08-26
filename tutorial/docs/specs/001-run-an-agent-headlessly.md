# Run an agent headlessly

Run one agent, with one job to be done, and no human in its conversation.

## Key concept

An **agent** is a harness with a job to be done. The harness is ordinary software: it prepares the
input, calls a model, and handles what comes back. The job to be done is what you hand it.

Pi is a harness. This command gives it a small job directly:

```sh
pi -p "What is the capital of France?"
```

The `-p` option supplies the prompt. Pi prints the response and then exits.

This project-specific command gives Pi a job on standard input:

```sh
echo "Describe what this calculator does, in three sentences." \
  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
```

Three things in that command are worth naming.

The text on standard input is the **job to be done**. Nothing else tells the agent what you want.

The run is **headless**: Pi does the job and exits, with no human in the conversation while it
works. `-p` asks for that explicitly. That matters because everything you build after this runs
without you watching it. An agent you have to talk to cannot be part of something that runs on its
own.

`--tools read,grep,find,ls` is the **boundary**. This agent can look at the calculator and nothing
else — it cannot change a file even if it decides it should. You will draw a different boundary for
every agent in this tutorial, and each boundary is a deliberate choice.

## Implementation order

The learner creates no files in this lesson. Teach it in this order:

1. **Run a simple Pi prompt.** Run `pi -p "What is the capital of France?"` and observe that Pi
   prints an answer and exits. The answer is unremarkable; the mechanics are the lesson.
2. **Run the project-specific command.** From the session workspace, run the calculator command
   above and read what comes back.
3. **Change the job.** Have the learner replace the sentence on standard input with a question of
   their own and run it again. The harness did not change; only the job did. Ask them what would
   happen if a script ran this and walked away — nothing is waiting for a person, which is the
   whole point.

## Checks

Ask the learner to answer these from what they just ran, in their own words:

- Which part of the command was the harness, and which part was the job to be done?
- What made the run headless, and why does that matter for what comes next?
- What could this agent not have done, however it was asked?

## Pressure test

This agent only describes. The next lesson gives an agent a job that changes the calculator, which
means giving it a different boundary — and raises the question this tutorial is built around: who
checks the change?
