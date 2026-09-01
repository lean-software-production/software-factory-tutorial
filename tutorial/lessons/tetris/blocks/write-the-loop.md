---
type: editor-practice
outcome: Write a bounded loop script that runs exactly five Pi passes.
path: ralph.sh
tutor: |-
  Accept when `ralph.sh` is a shell script that runs exactly five Pi passes over `prompt.md` and
  prints explicit Pass N/5 start and completion boundaries.

  The script must run the exact `pi -p < prompt.md>` unconfigured/default command.
  It must run once in each of exactly five passes:

      for pass in 1 2 3 4 5; do
        echo "Pass $pass/5: starting"
        pi -p < prompt.md
        echo "Pass $pass/5: done"
      done

  It may include `set -euo pipefail` and a shebang. The pass boundaries must be explicit and
  machine-readable so terminal evidence can confirm all five ran: Pass 1/5: starting,
  Pass 1/5: done, Pass 2/5: starting, Pass 2/5: done, Pass 3/5: starting, Pass 3/5: done,
  Pass 4/5: starting, Pass 4/5: done, Pass 5/5: starting, and Pass 5/5: done.

  Reject `--no-session`, provider/model options, other Pi flags, a hard-coded provider/model,
  unbounded loops such as `while :`, and loops without a fixed upper bound. Reject fewer or more
  than five Pi passes, and reject fewer or more than five Pi invocations.
---

## Write the loop

Write `ralph.sh`, the script that drives the factory.

The loop feeds the same prompt to Pi each time. Here we run exactly five passes, then
stop, just for safety.

```sh
#!/usr/bin/env bash

for pass in 1 2 3 4 5; do
  echo "Pass $pass/5: starting"
  pi -p < prompt.md
  echo "Pass $pass/5: done"
done
```

