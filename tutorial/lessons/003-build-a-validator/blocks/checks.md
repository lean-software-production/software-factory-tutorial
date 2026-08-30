---
type: reflection
outcome: "Explain why the validator may run checks but must not edit the calculator."
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer verifies the terminal
  progress announcement, no calculator edits, required VERDICT first line in the captured findings,
  quoted evidence, and the missing-baseline guard. Accept PASS or FAIL as long as the format and
  evidence are real. If needed, have them remove .tmp/refactor-quality-before.txt to see the guard.
  The why is that the next lesson needs trustworthy findings and a validator that cannot repair its
  own complaints.
---

## Checks

From the active workspace, make the new script executable and run a doer turn followed by a
validation turn:

```sh
chmod +x factory/refactor-validate.sh
./factory/refactor-do.sh
./factory/refactor-validate.sh
```

Verify by hand that the validator:

- announces itself before Pi is invoked;
- does not edit any file in `calculator/`;
- may print the terminal progress line before Pi answers, but the first non-empty line of
  `factory/.tmp/refactor-validate-findings.txt` is exactly `VERDICT: PASS` or `VERDICT: FAIL`; and
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
