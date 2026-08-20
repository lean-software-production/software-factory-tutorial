---
type: terminal-practice
tutor: |-
  Guide the learner through creating factory/watch.sh, running the line as a background job in the
  embedded terminal, running watchers against the same event files, and adding a cost watcher
  expression. Success means ./factory/watch.sh refactor follows events while the run is still
  active, shows tool names or cost as events arrive, multiple watchers can run at once as shell
  jobs, Ctrl-C on the foreground watcher does not stop the line, and no-argument usage fails
  clearly. Accept equivalent jq output formatting, but not a watcher that changes run.sh or the
  stations. Clue toward tail -f -n +1 and jq --unbuffered if output appears only after the run. The
  point is that observability is a separate consumer of the same record.
---

## Implementation order

Work in this order. Complete each small step before moving to the next one:

1. **Write the watcher.** Create `factory/watch.sh`. It takes the name of a line and follows its
   record:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   line="${1:?usage: watch.sh <line>}"

   tail -f -n +1 "$line"/.tmp/events/*.jsonl \
     | jq -r --unbuffered '
         select(.type=="tool_execution_start")
         | "→ \(.toolName) \(.args.command // .args.path // "")"'
   ```

   `-n +1` starts from the beginning of each file rather than the last ten lines, so a watcher
   attached
   late still shows the whole run. `--unbuffered` makes `jq` emit each line as it arrives instead of
   holding output back until its buffer fills, which is the difference between watching a line and
   watching nothing for thirty seconds and then everything at once.

   The line's name is an argument, not a constant. This watcher would work unchanged on a second
   line
   that nobody has built.

2. **Watch a run.** Use the embedded terminal as one shell session at the repository root. Start
   the line as a background job, saving its unreadable JSON firehose to a regenerated file:

   ```sh
   ./factory/refactor/run.sh > factory/refactor/.tmp/run-output.txt 2>&1 &
   line_pid=$!
   ```

   Then run the watcher in the foreground while the line works:

   ```sh
   ./factory/watch.sh refactor
   ```

   Keep the terminal visible. The background line is still writing the record, and the foreground
   watcher is a list of what the stations are doing. When enough events have appeared, press Ctrl-C.
   That stops the watcher, not the background line. If the line is still running, `wait "$line_pid"`
   waits for it.

3. **Add the running cost.** A second expression reads the same stream. In one embedded terminal,
   start the tool watcher as a background job and run the cost watcher in the foreground:

   ```sh
   ./factory/watch.sh refactor > factory/refactor/.tmp/watch-tools.txt &
   watcher_pid=$!
   tail -f -n +1 factory/refactor/.tmp/events/*.jsonl \
     | jq -r --unbuffered '
         select(.type=="message_end")
         | .message.usage.cost.total? // empty
         | "cost +\(.)"'
   ```

   Press Ctrl-C when the cost stream has proved the point, then stop the background watcher if it is
   still running:

   ```sh
   kill "$watcher_pid" 2>/dev/null || true
   ```

   Two consumers, one record, no coordination between them. That is the property the lesson is for.
