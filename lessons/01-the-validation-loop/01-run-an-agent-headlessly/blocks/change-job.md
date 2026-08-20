---
type: terminal-practice
tutor: |-
  Have the learner run the displayed command in the embedded terminal.

  Success: Pi answers the new question and exits. The invocation is unchanged; only the quoted
  input after echo is different.

  If the learner needs help, remind them to keep the pipe and the parenthesized Pi command intact.
  Changing the quoted text changes the job, while the same harness still prepares the input, calls
  the model, and handles its response.
---

## Change only the job to be done

Run this command from the repository root:

```sh command
echo "What files make up this calculator, and what does each one appear to do?" \
  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
```

Pi should answer the new question and exit. Only the job changed; the invocation did not.
