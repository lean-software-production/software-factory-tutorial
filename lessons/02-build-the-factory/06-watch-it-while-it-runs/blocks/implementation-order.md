---
type: terminal-practice
tutor: |-
  Guide the learner through creating factory/watch.sh, running the line and watcher in separate
  terminals, and adding a cost watcher expression. Success means ./factory/watch.sh refactor follows
  events while the run is still active, shows tool names or cost as events arrive, multiple watchers
  can run at once, Ctrl-C on the watcher does not stop the line, and no-argument usage fails
  clearly. Accept equivalent jq output formatting, but not a watcher that changes run.sh or the
  stations. Clue toward tail -f -n +1 and jq --unbuffered if output appears only after the run. The
  point is that observability is a separate consumer of the same record.
---

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Write the watcher.** Create `factory/watch.sh`. It takes the name of a line and follows its
   record:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   line="${1:?usage: watch.sh <line>}"

   tail -f -n +1 "$line"/events/*.jsonl \
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

2. **Watch a run.** Two terminals, both at the repository root. In the first:

   ```sh
   ./factory/refactor/run.sh
   ```

   and in the second, while it works:

   ```sh
   ./factory/watch.sh refactor
   ```

   Have the learner keep both visible. The terminal running the line is still an unreadable JSON
   firehose, and the one watching it is a list of what the stations are doing. Neither script knows
   the
   other exists.

3. **Add the running cost.** A second expression over the same stream, either as a second watcher in
   a
   third terminal or as a flag on the first:

   ```sh
   tail -f -n +1 "$line"/events/*.jsonl \
     | jq -r --unbuffered '
         select(.type=="message_end")
         | .message.usage.cost.total? // empty
         | "cost +\(.)"'
   ```

   Two consumers, one record, no coordination between them. That is the property the lesson is for.
