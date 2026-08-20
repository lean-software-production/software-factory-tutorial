---
type: terminal-practice
tutor: |-
  Have the learner run the displayed command in the embedded terminal.

  Success: Pi prints a short description of the calculator and exits. The model's exact wording
  does not matter.

  If the learner needs help, point out that the quoted text after echo is the job. The subshell
  changes into calculator, and Pi runs with -p, no session, and only read-only tools.
---

## Run the supplied headless command

Run this command from the repository root:

```sh
echo "Describe what this calculator does, in three sentences." \
  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
```

Pi should print a short description of the calculator and exit. Its exact wording is not important.
