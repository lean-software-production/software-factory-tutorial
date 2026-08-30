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

A Ralph Loop feeds the same prompt to Pi more than once. Here we run exactly five passes, then
stop. The script must run the exact `pi -p < prompt.md>` unconfigured/default command once in each
of exactly five passes so each pass reads your prompt from stdin. Pi uses your configured or
default model.

Print explicit Pass N/5 boundaries so you can see which pass is running:

```sh
#!/usr/bin/env bash
set -euo pipefail

for pass in 1 2 3 4 5; do
  echo "Pass $pass/5: starting"
  pi -p < prompt.md
  echo "Pass $pass/5: done"
done
```

The output boundaries should be the complete sequence: Pass 1/5: starting, Pass 1/5: done,
Pass 2/5: starting, Pass 2/5: done, Pass 3/5: starting, Pass 3/5: done, Pass 4/5: starting,
Pass 4/5: done, Pass 5/5: starting, and Pass 5/5: done.

The tutor will reject `--no-session`, provider/model options, and other Pi flags. It will reject a
hard-coded provider/model and unbounded loops. It will reject fewer or more than five passes, and
reject fewer or more than five Pi invocations. Keep this script plain so it uses your configured or
default Pi setup.

Do not use `while :` or any other unbounded loop. Five passes at a real task will take real time;
the fixed limit is what makes this a first taste rather than a production system.
