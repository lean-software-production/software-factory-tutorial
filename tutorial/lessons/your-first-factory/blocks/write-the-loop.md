---
type: editor-practice
outcome: Write a bounded Ralph-loop script that runs exactly two Pi passes.
path: ralph.sh
tutor: |-
  Accept when `ralph.sh` is a shell script that runs exactly two bounded Pi passes over `prompt.md`.

  The script should use syntax supported by this Pi version, for example:

      for pass in 1 2; do
        echo "=== Pi pass $pass of 2 ==="
        pi --no-session -p < prompt.md
      done

  It may include `set -euo pipefail` and a shebang. Reject unbounded loops such as `while :`, loops
  without a fixed upper bound, or scripts that run fewer or more than two Pi passes.
---

## Write the loop

Write `ralph.sh`, the smallest useful Ralph Loop driver.

A Ralph Loop feeds the same worker prompt to an agent more than once. Here we will keep it
deliberately small: exactly two Pi passes, then stop. That limit lets you see the shape of a
factory without creating an unattended production system.

Use `pi --no-session -p < prompt.md` so each pass reads your prompt and exits without saving a Pi
session. Do not use `while :` or any other unbounded loop.
