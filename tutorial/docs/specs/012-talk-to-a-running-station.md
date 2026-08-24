# Talk to a running station

Give one station a channel, and say something to it while it works.

## Key concept

Headless has meant one thing since lesson 001: no human in the conversation while the station works.
The learner has read that as *the station cannot be spoken to*, which is not what it says and not what
is true.

Pi's third output mode changes what standard input is for. With `-p`, stdin is the prompt: the station
reads it, does the job, and exits. With `--mode rpc`, **stdin is a command channel** — the process stays
alive and reads JSON commands one per line, for as long as something keeps the channel open.

One of those commands is `steer`, and the docs are precise about when it lands: the message is
delivered after the current assistant turn finishes executing its tool calls, and before the next model
call. Not an interruption, and not a queue for later. The station finishes what it is doing, and then
what the learner said is in its context.

Nobody is in the conversation. Something can still be put into it.

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Make the doer steerable.** The doer is the station worth steering, because it is the one that
   makes choices the learner might disagree with. Replace its invocation in `run.sh`:

   ```sh
   echo "Starting doer..."
   rm -f control
   mkfifo control
   (cd ../../calculator && pi --no-session --mode rpc \
       --tools read,edit,write,grep,find,ls) \
     < control > ".tmp/events/$iteration-do.jsonl" &
   doer=$!
   sleep infinity > control &
   holder=$!

   jq -cn --arg m "$(cat refactor.md success.md)" '{type:"prompt",message:$m}' > control

   until grep -q '"type":"agent_end"' ".tmp/events/$iteration-do.jsonl"; do sleep 1; done

   kill "$holder" "$doer" 2>/dev/null || true
   rm -f control
   ```

   The other three stations keep `-p`. Steering a station that runs for eight seconds and produces one
   verdict buys nothing, and giving every station a channel would triple the plumbing to make the same
   point once.

2. **Understand the holder, because it is the strangest line in Part 2.** A named pipe returns
   end-of-file to its reader when its last writer closes. Without `sleep infinity > control &`, Pi would
   see EOF the moment the `jq` that sent the prompt finished, and exit before doing any work.

   That process does nothing. Its entire job is to hold the channel open, and it is the reason the
   station stays alive between commands.

   Point out what the learner has just built. A channel on disk, a process holding it open, and a
   long-running program reading commands from it: that is the whole of what a daemon is. They are not
   using one; they made the smallest possible one out of two lines of shell.

3. **Clean up after it.** Two background processes and a file in the filesystem, in a script that can
   be stopped with Ctrl-C at any point. Add a trap near the top of `run.sh`:

   ```sh
   cleanup() {
     [ -n "${holder:-}" ] && kill "$holder" 2>/dev/null || true
     [ -n "${doer:-}" ] && kill "$doer" 2>/dev/null || true
     rm -f control
   }
   trap cleanup EXIT
   ```

   Say plainly why this is in the lesson rather than left as an exercise. Every previous station exited
   on its own when its work was done. This one exits when someone tells it to, and a learner who
   Ctrl-Cs out of a run without this trap has left a model process and a `sleep` running on their
   station with nothing to stop them.

4. **Write the steering tool.** Create `factory/steer.sh`, beside `watch.sh` and `ask.sh`:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   line="${1:?usage: steer.sh <line> <message>}"
   shift

   jq -cn --arg m "$*" '{type:"steer",message:$m}' > "$line"/control
   ```

   `jq` is building the JSON here rather than reading it — the same tool doing the inverse job. Do not
   let the learner hand-roll this with `echo`. The first message anyone actually wants to send contains
   an apostrophe, and a hand-rolled `echo '{"message":"don't touch the parser"}'` produces a parse
   error instead of a steer.

   **The `-c` is not optional.** The channel is JSONL and the reader splits on newlines, one command per
   line. `jq` pretty-prints by default, so without `-c` a single command arrives as eight lines, none of
   which parses as a whole object, and the station sits waiting for an instruction it has already been
   given. It fails silently, which is what makes it worth saying before the learner meets it.

5. **Show the station's replies.** `watch.sh` currently reports tool calls, which is no use for reading
   an answer. Extend its `jq` so the assistant's words come through too:

   ```sh
   tail -f -n +1 "$line"/events/*.jsonl \
     | jq -rj --unbuffered '
         if .type=="tool_execution_start" then "\n→ \(.toolName)\n"
         elif .type=="message_update" and .assistantMessageEvent.type=="text_delta"
           then .assistantMessageEvent.delta
         else empty end'
   ```

6. **Steer a run.** Three terminals, all at the session workspace. Run the line in the first, watch it in
   the second, and in the third, while the doer is working:

   ```sh
   ./factory/steer.sh refactor "What are you changing, and why that file?"
   ./factory/steer.sh refactor "Leave the parser alone. The duplication is in the formatter."
   ```

   The answer arrives in the watcher.

   **Steer early.** A steering message is delivered after the current assistant turn finishes its tool
   calls and before the next model call, so a station with no next model call never receives one. Steer
   a station that is about to finish and the command is accepted, queued, and then thrown away when the
   station exits — no error, no warning, and `queue_update` in the record showing it still pending. The
   learner should send one steer in the first seconds of a turn and one just before it ends, and see the
   difference. Steering is a conversation with a station that is still working, not a way to recall one
   that has finished.

## Why this needs no daemon

The learner has three terminals, and each one does exactly one blocking thing: the first runs the line,
the second follows a file, the third writes a line to a pipe and exits. Nothing has to read the
learner's typing and wait for a station to finish at the same time, which is the only genuinely awkward
thing about this shape.

A daemon exists to connect a short-lived command to a handle held inside some other process. Here the
handle is a path on disk, and any terminal that can write to a file can reach it.

Pi also ships a typed client for exactly this — a class with `start`, `stop`, `prompt`, `steer` and
`onEvent` methods, which would make this a dozen lines of Node instead of two dozen of shell. It is
better code, and it is the wrong choice here: it would put "how do you talk to a running process"
behind a method call the learner cannot see through, at the second-to-last lesson of a tutorial that
has been shell all the way down. Mention it as the thing to reach for outside a tutorial.

## Checks

From the session workspace, in three terminals:

```sh
./factory/refactor/run.sh
./factory/watch.sh refactor
./factory/steer.sh refactor "Which file are you working on?"
```

Verify by hand that:

- the doer keeps running after the prompt is sent, rather than exiting immediately;
- the answer to a steered question appears in the watcher, in the same iteration's record;
- a steer sent while a tool call is in flight lands after that tool call, not in the middle of it;
- a steered instruction actually changes what the doer does next;
- a message containing an apostrophe or a double quote is delivered intact;
- a steer sent just as the station finishes shows up in a `queue_update` and changes nothing, which is
  the queue being discarded rather than a failure; and
- Ctrl-C out of `run.sh` leaves no `pi` and no `sleep` processes behind:

  ```sh
  pgrep -fl 'pi --no-session|sleep infinity'
  ```

Then remove the holder line and run it again. The doer exits without doing anything, and the record for
that iteration is nearly empty. Put it back.

## Pressure test

The learner can now talk to a station while it works. They can ask it what it is doing and tell it to
do something else, and the record shows both.

One station.

Everything above it is still deaf. `run.sh` decided which station would run, decided this iteration
would be a refactoring rather than a repair, and will decide in a moment whether the run is over — and
there is nothing to say to it. It has been making those choices since lesson 007, and every one of them
was made by code the learner wrote and cannot address.

The thing choosing which station runs next has no voice at all. The last lesson is about what that
leaves the learner doing.
