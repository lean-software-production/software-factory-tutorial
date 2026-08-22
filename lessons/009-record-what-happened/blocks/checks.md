---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer confirms one JSONL file
  per station per iteration, text extraction leaves plain findings and commit messages, jq reports
  plausible tools and cost, and the terminal is unreadable while the record is complete. Accept
  JSONL location under .tmp/events as intended. Follow up if the learner expects JSON mode to be the
  view; the lesson says it is the record.
---

## Checks

From the repository root, run a fresh line and then inspect what it left behind:

```sh
./factory/refactor/run.sh
ls factory/refactor/.tmp/events/
```

Verify by hand that:

- there is one `.jsonl` file per station per iteration, named for both;
- `.tmp/validate-findings.txt` still opens with `VERDICT: PASS` or `VERDICT: FAIL` on its first
  non-empty
  line, and the branch still routes on it;
- `git log -1` shows a commit message with no JSON in it;
- the two `jq` queries above return a plausible tool tally and a cost; and
- the terminal, during the run, is unreadable.

The last one is the finding, not a defect. Measure it if you are unconvinced:

```sh
wc -l factory/refactor/.tmp/events/*.jsonl
```
