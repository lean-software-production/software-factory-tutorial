---
type: terminal-practice
tutor: |-
  Guide the learner through choosing stop conditions, adding max_iterations, iteration, and
  consecutive_failures, removing the read, and printing the final iteration count. Success means
  ./factory/refactor/run.sh never waits for input, announces each iteration, stops at the ceiling or
  after two consecutive failures, resets the failure count on PASS, and reports how long it ran.
  Accept different numeric limits if the two demonstrated conditions remain. If stuck, have them
  trace where the old read handed control to the learner. The lesson matters because deciding when
  the line is finished is part of the orchestrator job.
---

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Choose the stopping conditions.** Have the learner pick before writing anything, because each
   one
   fails differently and the choice is the lesson:

   - **A ceiling.** Stop after N iterations. Crude, honest, and never wrong about terminating.
   - **Giving up.** Stop after N failing verdicts in a row, on the grounds that a line failing
     repeatedly is not going to succeed by being asked again.
   - **No progress.** Compare this iteration's quality report with the last one and stop when
     nothing
     moved.
   - **A budget.** Stop when the run has cost enough. The line cannot answer this yet; the next
     lesson
     is where it can.

   Build the first two. They are four lines between them, they fail in opposite directions, and
   together they cover both ways a run ends badly: one that would go forever, and one that is going
   nowhere.

2. **Count.** `run.sh` gains three variables above the loop and a different loop condition:

   ```sh
   max_iterations=5
   iteration=0
   consecutive_failures=0

   while [ "$iteration" -lt "$max_iterations" ]; do
     iteration=$((iteration + 1))
     echo "=== Iteration $iteration of $max_iterations ==="
   ```

   Note what the announcement is for. Nobody is watching a prompt any more, so the scrollback is the
   only record of where one iteration ended and the next began.

3. **Record the outcome, and give up if it keeps failing.** Inside the branch the learner already
   wrote, each arm now updates the count, and a check after it decides whether to carry on:

   ```sh
   if [ "$verdict" = "VERDICT: FAIL" ]; then
     consecutive_failures=$((consecutive_failures + 1))
     echo "Starting repair..."
     ...
   else
     consecutive_failures=0
     echo "Starting commit..."
     ...
   fi

   if [ "$consecutive_failures" -ge 2 ]; then
     echo "Stopping: two failing verdicts in a row."
     break
   fi
   ```

   The reset in the passing arm is the part worth checking. Without it the variable counts failures
   rather than *consecutive* failures, and a line that fails, succeeds, and fails again stops for a
   reason that never happened.

4. **Delete the `read`, and say what happened.** The loop ends, and the last thing the script does
   is
   report:

   ```sh
   echo "Line finished after $iteration iterations."
   ```

   Nobody was there. The script saying how it ended is the only way anyone finds out.
