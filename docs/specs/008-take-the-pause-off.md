# Take the pause off

Delete the `read`, and give the line a reason to stop.

## Key concept

The `read` at the bottom of the loop is the last thing on this line that requires a person. Delete it
and the line runs until something stops it — which means something has to.

That something is `run.sh`, and it is not taking on a new role. The lexicon's orchestrator is
responsible for "starting a line, handing each station its inputs, choosing what runs next where the
graph branches, handling failures and retries, and **deciding when the line is finished**." The
previous lesson gave `run.sh` the branch. This lesson gives it the ending, and after it the
orchestrator is doing the whole of its job.

This is also the first time on this line that anything is remembered from one iteration to the next.
Every station so far has been handed its inputs and run to completion with no memory of the turn
before; the criteria outlive an iteration, but nothing else does. A stop condition cannot work that
way. It has to count.

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Choose the stopping conditions.** Have the learner pick before writing anything, because each one
   fails differently and the choice is the lesson:

   - **A ceiling.** Stop after N iterations. Crude, honest, and never wrong about terminating.
   - **Giving up.** Stop after N failing verdicts in a row, on the grounds that a line failing
     repeatedly is not going to succeed by being asked again.
   - **No progress.** Compare this iteration's quality report with the last one and stop when nothing
     moved.
   - **A budget.** Stop when the run has cost enough. The line cannot answer this yet; the next lesson
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

4. **Delete the `read`, and say what happened.** The loop ends, and the last thing the script does is
   report:

   ```sh
   echo "Line finished after $iteration iterations."
   ```

   Nobody was there. The script saying how it ended is the only way anyone finds out.

## Checks

From the repository root:

```sh
./factory/refactor/run.sh
```

Verify by hand that:

- it never waits for input, from the first iteration to the last;
- each iteration announces its number, and the announcements bracket the phases within it;
- it stops on its own at the ceiling and says so;
- `git log --oneline` shows one commit for each passing verdict and none for the failing ones; and
- the run ends with a line naming how many iterations it took.

Then check the give-up rule without waiting for it to happen by accident. Set `max_iterations=10`,
make `success.md` demand something the doer cannot reach in one change — a criterion about the whole
codebase, not one file — and run it again. It should stop early, and say which rule stopped it.

Put `success.md` back afterwards.

## Pressure test

Run the line and go and make coffee.

Come back to a finished run, five iterations deep, some number of commits, and a wall of scrollback.
Now answer two questions.

**What did it do?** `git log` covers the iterations that passed. The ones that failed left a repair
turn, a diff, and nothing else — and the findings that explained why were overwritten by the next
iteration's.

**What did it cost?** Nothing anywhere has ever printed that. Not in the scrollback, not in a file, not
in the commits. Five iterations, four stations each, and the number does not exist.

The learner has just spent the tutorial's central move: they built something, ran it, and now cannot
tell what it did. The next lesson gives the line a memory.
