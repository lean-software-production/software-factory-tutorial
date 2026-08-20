---
type: terminal-practice
tutor: |-
  Guide the learner through replacing only the doer station with RPC mode, creating and holding the
  named pipe, adding cleanup, writing steer.sh with jq -cn, extending watch.sh to show assistant
  text, and steering an active run. Success means the doer stays alive after the prompt, steered
  questions or instructions appear in the same iteration record, quotes and apostrophes survive JSON
  encoding, late steers show as queued but have no effect, and Ctrl-C leaves no pi or sleep holder
  processes. Accept small cleanup variations if they reliably kill holder and doer and remove
  control. Clue toward sleep infinity > control and compact JSONL if the doer exits immediately or
  steers silently fail. The point is that headless does not prevent a running station from receiving
  context between turns.
---

## Implementation order

Work in this order. Complete each small step before moving to the next one:

1. **Make the doer steerable.** The doer is the station worth steering, because it is the one that
   makes choices you might disagree with. Replace its invocation in `run.sh`:

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

   The other three stations keep `-p`. Steering a station that runs for eight seconds and produces
   one
   verdict buys nothing, and giving every station a channel would triple the plumbing to make the
   same
   point once.

2. **Understand the holder, because it is the strangest line in Part 2.** A named pipe returns
   end-of-file to its reader when its last writer closes. Without `sleep infinity > control &`, Pi
   would
   see EOF the moment the `jq` that sent the prompt finished, and exit before doing any work.

   That process does nothing. Its entire job is to hold the channel open, and it is the reason the
   station stays alive between commands.

   Look at what you have just built. A channel on disk, a process holding it open, and a
   long-running program reading commands from it: that is the whole of what a daemon is. You are
   not using one; you made the smallest possible one out of two lines of shell.

3. **Clean up after it.** Two background processes and a file in the filesystem, in a script that
   can
   be stopped with Ctrl-C at any point. Add a trap near the top of `run.sh`:

   ```sh
   cleanup() {
     [ -n "${holder:-}" ] && kill "$holder" 2>/dev/null || true
     [ -n "${doer:-}" ] && kill "$doer" 2>/dev/null || true
     rm -f control
   }
   trap cleanup EXIT
   ```

   Say plainly why this is in the lesson rather than left as an exercise. Every previous station
   exited
   on its own when its work was done. This one exits when someone tells it to, and if you Ctrl-C out
   of a run without this trap, you have left a model process and a `sleep` running on your station
   with nothing to stop them.

4. **Write the steering tool.** Create `factory/steer.sh`, beside `watch.sh` and `ask.sh`:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   line="${1:?usage: steer.sh <line> <message>}"
   shift

   jq -cn --arg m "$*" '{type:"steer",message:$m}' > "$line"/control
   ```

   `jq` is building the JSON here rather than reading it — the same tool doing the inverse job.
   Do not hand-roll this with `echo`. The first message anyone actually wants to send contains an
   apostrophe, and a hand-rolled `echo '{"message":"don't touch the parser"}'` produces a parse
   error instead of a steer.

   **The `-c` is not optional.** The channel is JSONL and the reader splits on newlines, one command
   per
   line. `jq` pretty-prints by default, so without `-c` a single command arrives as eight lines,
   none of
   which parses as a whole object, and the station sits waiting for an instruction it has already
   been
   given. It fails silently, which is what makes it worth saying before you meet it.

5. **Show the station's replies.** `watch.sh` currently reports tool calls, which is no use for
   reading
   an answer. Extend its `jq` so the assistant's words come through too:

   ```sh
   tail -f -n +1 "$line"/events/*.jsonl \
     | jq -rj --unbuffered '
         if .type=="tool_execution_start" then "\n→ \(.toolName)\n"
         elif .type=="message_update" and .assistantMessageEvent.type=="text_delta"
           then .assistantMessageEvent.delta
         else empty end'
   ```

6. **Steer a run.** Three terminals, all at the repository root. Run the line in the first, watch it
   in
   the second, and in the third, while the doer is working:

   ```sh
   ./factory/steer.sh refactor "What are you changing, and why that file?"
   ./factory/steer.sh refactor "Leave the parser alone. The duplication is in the formatter."
   ```

   The answer arrives in the watcher.

   **Steer early.** A steering message is delivered after the current assistant turn finishes its
   tool calls and before the next model call, so a station with no next model call never receives
   one. Steer a station that is about to finish and the command is accepted, queued, and then
   thrown away when the station exits — no error, no warning, and `queue_update` in the record
   showing it still pending. The send one steer in the first seconds of a turn and one just
   before it ends, and see the difference. Steering is a conversation with a station that is
   still working, not a way to recall one that has finished.
