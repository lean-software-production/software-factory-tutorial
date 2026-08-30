---
type: editor-practice
outcome: Write a bounded loop script that runs exactly five Pi passes.
path: ralph.sh
tutor: |-
  Accept when `ralph.sh` is a shell script that runs exactly five Pi passes over `prompt.md` and
  prints explicit Pass N/5 start and completion boundaries.

  The script should use syntax such as:

      for pass in 1 2 3 4 5; do
        echo "Pass $pass/5: starting"
        pi -p < prompt.md
        echo "Pass $pass/5: done"
      done

  It may include `set -euo pipefail` and a shebang. The pass boundaries must be explicit and
  machine-readable so terminal evidence can confirm all five ran.

  Reject unbounded loops such as `while :`, loops without a fixed upper bound, and loops that run
  fewer or more than five Pi passes.
---

## Write the loop

Write `ralph.sh`, the script that drives the factory.

A Ralph Loop feeds the same worker prompt to an agent more than once. Here we run exactly five
passes, then stop. Use `pi -p < prompt.md` so each pass reads your prompt from stdin. Pi uses
your configured or default model.

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

Do not use `while :` or any other unbounded loop. Five passes at a real task will take real time;
the fixed limit is what makes this a first taste rather than a production system.
