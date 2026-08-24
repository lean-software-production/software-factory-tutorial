---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer verifies the validator
  announcement, no calculator edits, required VERDICT first line, quoted evidence, and the
  missing-baseline guard. Accept PASS or FAIL as long as the format and evidence are real. If
  needed, have them remove .tmp/refactor-quality-before.txt to see the guard. The why is that the
  next lesson needs trustworthy findings and a validator that cannot repair its own complaints.
---

## Checks

From the session workspace, make the new script executable and run a doer turn followed by a
validation turn:

```sh
chmod +x factory/refactor-validate.sh
./factory/refactor-do.sh
./factory/refactor-validate.sh
```

Verify by hand that the validator:

- announces itself before Pi is invoked;
- does not edit any file in `calculator/`;
- returns exactly one `PASS` or `FAIL` verdict on its first non-empty line; and
- quotes what it actually ran, rather than asserting a conclusion.

Then check the guard. The run above left a baseline behind, so delete it and run the validator on
its
own:

```sh
rm factory/.tmp/refactor-quality-before.txt
./factory/refactor-validate.sh
```

Confirm it refuses and exits non-zero, rather than inventing a comparison against a baseline that is
not there. Run `./factory/refactor-do.sh` again afterwards to restore one.
