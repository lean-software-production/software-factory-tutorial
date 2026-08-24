---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer confirms live output,
  tool names matching station activity, watcher independence from the run, multiple watcher jobs,
  and clear usage failure without a line argument. Accept either tool-call or cost watcher
  output. Follow up if the watcher is added inside run.sh; observability should be a separate
  consumer of existing records.
---

## Checks

From the tutorial root in the embedded terminal, start the line as a background job and run the
watcher in the foreground:

```sh
./factory/refactor/run.sh > factory/refactor/.tmp/run-output.txt 2>&1 &
line_pid=$!
./factory/watch.sh refactor
```

Verify by hand that:

- output appears while the line is still working, not after it finishes;
- the tool names shown correspond to what the stations are actually doing — file reads during
  validation, edits during a doer turn;
- stopping the foreground watcher with Ctrl-C does not affect the background run;
- starting one watcher as a background job and another in the foreground works, and neither
  interferes with the other; and
- `./factory/watch.sh` with no argument fails with the usage message rather than doing something
  surprising.
