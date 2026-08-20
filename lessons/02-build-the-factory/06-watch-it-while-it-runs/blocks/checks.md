---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer confirms live output,
  tool names matching station activity, watcher independence from the run, multiple simultaneous
  watchers, and clear usage failure without a line argument. Accept either tool-call or cost watcher
  output. Follow up if the watcher is added inside run.sh; observability should be a separate
  consumer of existing records.
---

## Checks

From the repository root, with the line running in another terminal:

```sh
./factory/watch.sh refactor
```

Verify by hand that:

- output appears while the line is still working, not after it finishes;
- the tool names shown correspond to what the stations are actually doing — file reads during
  validation, edits during a doer turn;
- stopping the watcher with Ctrl-C does not affect the run at all;
- starting a second watcher alongside the first works, and neither interferes with the other; and
- `./factory/watch.sh` with no argument fails with the usage message rather than doing something
  surprising.
