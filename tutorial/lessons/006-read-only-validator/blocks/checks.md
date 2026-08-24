---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer points to the
  evidence-gathering announcement, four labelled sections in .tmp/evidence.txt, a verdict based on
  gathered output, no bash in the validator tool list, and no calculator/proof.txt after the hostile
  prompt test. Accept a failed validation if it quotes real evidence. Follow up if they treat the
  prompt prohibition as the boundary; the boundary is the missing bash tool.
---

## Checks

From the tutorial root, run a doer turn and then a validation turn:

```sh
./factory/refactor/do.sh
./factory/refactor/validate.sh
```

Verify by hand that:

- the harness announces the evidence-gathering step before it happens;
- `factory/refactor/.tmp/evidence.txt` exists and contains four labelled sections;
- the verdict still opens with `VERDICT: PASS` or `VERDICT: FAIL` on its first non-empty line;
- the findings quote the output the harness gathered, rather than describing commands the validator
  claims to have run; and
- `factory/refactor/run.sh` gathers the same evidence and passes the same three files.

Then repeat the previous lesson's demonstration, which should now fail. Add a line to `validate.md`
asking the validator to create `calculator/proof.txt`, run the validator, and look:

```sh
ls calculator/proof.txt
```

There is no file, and the validator has no way to make one. Remove the line again.
