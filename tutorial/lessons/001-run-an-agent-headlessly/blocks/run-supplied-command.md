---
type: terminal-practice
outcome: "Identify the job and harness in a supplied command."
tutor: |-
  Have the learner run the displayed command in the embedded terminal.

  Success: Pi prints a short description of the calculator and exits. The model's exact wording
  does not matter.

  If the learner needs help, point out that the quoted text after echo is the job. The subshell
  changes into calculator, and Pi runs with -p, no session, and only read-only tools.
---

## Get a description of the calculator

Run this command, to get `pi` to describe the project we're going to be working in.

```sh command
echo "Describe what this calculator does, in three sentences." \
  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
```

Note that we're passing it a list of tools it's allowed to use. Here's Pi's [reference documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#tool-options) for the `--tool` option.

Pi should print a short description of the calculator and exit.