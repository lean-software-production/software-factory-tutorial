---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer verifies run.sh
  executes doer before validator, waits at the pause, writes the last verdict, and that validate.md
  reports against every success.md criterion. It should also identify why the folder edge and shared
  criteria matter. Accept equivalent success criteria if they are durable and evidence-backed.
  Follow up by having them inspect factory/refactor/.tmp/validate-findings.txt when unsure.
---

## Checks

From the tutorial root, make the new script executable and run it:

```sh
chmod +x factory/refactor/run.sh
./factory/refactor/run.sh
```

Verify by hand that:

- each station announces itself before Pi is invoked;
- the doer runs before the validator on every pass;
- the validator reports one finding per criterion in `success.md`, not just the one it can measure;
- the loop waits for Enter before starting a second iteration; and
- `.tmp/validate-findings.txt` holds the last verdict after the loop pauses.
