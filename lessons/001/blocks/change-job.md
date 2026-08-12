---
title: Change only the job to be done
command: |-
  echo "What files make up this calculator, and what does each one appear to do?" \
    | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
context: Run from the repository root. Replace only the quoted standard input if you want to ask your own question.
expectedObservation: Pi answers the new question and exits. The harness and boundary did not change; only the job did.
help:
  explain: Changing the quoted text changes the job to be done. The same harness still prepares input, calls the model, and handles the response.
  command: Keep the pipe and the parenthesized Pi command the same. Replace the quoted sentence after echo.
  expected: The answer should address your new question and then stop. If a script ran this and walked away, nothing would wait for a person.
---
