---
type: terminal-practice
outcome: "Run a learner-visible exact command in the embedded terminal."
tutor: |-
  This is private tutor guidance for the live evaluator's exact-command scenario.

  Success: the learner runs the displayed command, the terminal prints "command block complete",
  and factory/.tmp/evaluator-command.txt exists. If they need help, direct them back to the visible command
  rather than inventing a different one.
---
## Run the exact command

Run this command from the temporary evaluation workspace:

```sh command
mkdir -p factory/.tmp && printf 'command block complete\n' > factory/.tmp/evaluator-command.txt && cat factory/.tmp/evaluator-command.txt
```

The output should be `command block complete`.
