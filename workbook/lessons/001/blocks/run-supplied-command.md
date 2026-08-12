---
title: Run the supplied headless command
command: |-
  echo "Describe what this calculator does, in three sentences." \
    | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
context: Run from the repository root.
expectedObservation: Pi prints a short description of the calculator and exits. The exact wording is not important; the mechanics are the lesson.
help:
  explain: The text before the pipe is the job to be done. The subshell changes into calculator, then Pi runs headlessly with -p and with read-only tools.
  command: Copy the command exactly, starting from the repository root. It uses standard input; you do not edit a file for this lesson.
  expected: Expect a brief answer about the calculator. It may vary because a model is producing it. What matters is that the run finishes without a conversation.
---
