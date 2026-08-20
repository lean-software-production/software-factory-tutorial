---
type: reflection
tutor: |-
  Ask the learner to answer the checks from the block. A satisfactory answer confirms RPC doer stays
  alive, steered messages appear after tool calls rather than interrupting them, a steer can change
  later work, quotes survive, late steers are queued but ineffective, and cleanup removes pi and
  sleep processes. Accept pgrep results that include unrelated Pi sessions only if the learner
  distinguishes them. Follow up if they omit the FIFO holder; without it the doer exits early.
---

## Checks

From the repository root, start the line and watcher in the background, then steer the active run:

```sh
./factory/refactor/run.sh > .tmp/refactor-run.log 2>&1 &
./factory/watch.sh refactor > .tmp/refactor-watch.log 2>&1 &
./factory/steer.sh refactor "Which file are you working on?"
```

Verify by hand that:

- the doer keeps running after the prompt is sent, rather than exiting immediately;
- the answer to a steered question appears in the watcher, in the same iteration's record;
- a steer sent while a tool call is in flight lands after that tool call, not in the middle of it;
- a steered instruction actually changes what the doer does next;
- a message containing an apostrophe or a double quote is delivered intact;
- a steer sent just as the station finishes shows up in a `queue_update` and changes nothing, which
  is
  the queue being discarded rather than a failure; and
- Ctrl-C out of `run.sh` leaves no `pi` and no `sleep` processes behind:

  ```sh
  pgrep -fl 'pi --no-session|sleep infinity'
  ```

Then remove the holder line and run it again. The doer exits without doing anything, and the record
for
that iteration is nearly empty. Put it back.
