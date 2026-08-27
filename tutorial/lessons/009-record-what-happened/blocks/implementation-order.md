---
type: terminal-practice
outcome: "Switch every model station to JSON mode, save one event log per station per iteration, and query the saved record for tool usage and cost with jq."
tutor: |-
  Guide the learner through creating .tmp/events, adding --mode json to every Pi station, saving
  JSONL files named by iteration and station, adding text_of, and extracting validator findings and
  commit messages from agent_end events. Success means each station leaves a JSONL record, branching
  and commits still use plain text extracted from that record, the jq tool-count and cost queries
  work, and the terminal output is no longer a useful human view. Accept minor file naming
  variations only if the names still identify iteration and station. Clue toward agent_end rather
  than message fragments if extraction is incomplete. The point is to change the output reader from
  human to program and record cost and events.
---

## Implementation order

Work in this order. Complete each small step before moving to the next one:

1. **Give the line somewhere to put the record.** At the top of `run.sh`, after the `cd`:

   ```sh
   mkdir -p .tmp/events
   ```

   The repository ignores the data files a run regenerates, and the record is one of them, so it
   stays out without anything further. The scripts and prompts beside it are tracked.

2. **Switch every station to `--mode json` and keep its output.** Each of the four Pi invocations
   gains
   the flag and writes to a file named for the iteration and the station:

   ```sh
   echo "Starting doer..."
   cat refactor.md success.md \
     | (cd ../../calculator && pi --no-session --mode json \
         --tools read,edit,write,grep,find,ls -p) \
     > ".tmp/events/$iteration-do.jsonl"
   ```

   The same shape for `validate`, `repair` and `commit`, each with the tools it already had.

3. **Get the text back out.** Two stations do not just run — the line reads what they said. The
   validator's verdict drove the branch through `tee`, and the commit station's message went
   straight
   into a file. Neither works now, because both files would hold JSON.

   Add one helper near the top of `run.sh`, and use it wherever the line needs a station's words:

   ```sh
   text_of() {
     jq -r 'select(.type=="agent_end") | .messages[]
            | select(.role=="assistant") | .content[]?
            | select(.type=="text") | .text' "$1"
   }
   ```

   ```sh
   text_of ".tmp/events/$iteration-validate.jsonl" > .tmp/validate-findings.txt
   text_of ".tmp/events/$iteration-commit.jsonl"   > .tmp/commit-message.txt
   ```

   The `agent_end` event carries every message the run generated, which is why the helper reads that
   one event rather than trying to reassemble the streamed fragments. Note that it returns the text
   of
   *every* assistant message in the run, one per line, so a station that narrated a step before
   answering puts that narration above its answer. This is the second time the anchored `^VERDICT:`
   from
   lesson 007 earns its place, and it is worth saying so: the verdict is now reliably somewhere in
   the
   findings file rather than reliably at the top of it. `run.sh` is now a program reading
   another program's output, which it has been pretending not to be since the `grep` in lesson 007.

4. **Ask the record what the last run cost.** This is the point of the lesson, so do it immediately
   rather than at the end. From the session workspace:

   ```sh
   jq -r 'select(.type=="tool_execution_start") | .toolName' \
     factory/refactor/.tmp/events/*.jsonl | sort | uniq -c

   jq -s '[.[] | select(.type=="message_end") | .message.usage.cost.total? // 0] | add' \
     factory/refactor/.tmp/events/*.jsonl
   ```

   What it did, and what it cost. Both questions from the previous lesson's pressure test, from a
   run
   nobody watched, answered by two commands over files the line wrote to itself.

   Run these against a fresh run before going on. A record you have never queried is a record you
   have no reason to trust.
