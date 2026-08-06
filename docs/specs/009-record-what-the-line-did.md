# Record what the line did

Change the reader, and the format changes with it.

## Key concept

Everything this line has printed was for a human standing at the terminal. Nobody is standing there any
more.

Pi's `--mode` flag chooses who its output is for. `text`, the default, is prose for a person. `json`
emits the same run as a stream of JSON lines — one per event — with the model's words inside them
alongside every tool call, every turn boundary, and the token usage and cost of every message.

That is the whole of the lesson: **a machine's output has a reader, and choosing the reader changes the
format.** The line gets a record it can be asked questions about, and it pays for it by giving up the
view the learner has had since lesson 001.

Be honest that this is a trade rather than an upgrade. Both halves are real, and the next lesson exists
because of the half that hurts.

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Give the line somewhere to put the record.** At the top of `run.sh`, after the `cd`:

   ```sh
   mkdir -p .tmp/events
   ```

   The repository ignores the data files a run regenerates, and the record is one of them, so it
   stays out without anything further. The scripts and prompts beside it are tracked.

2. **Switch every station to `--mode json` and keep its output.** Each of the four Pi invocations gains
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
   validator's verdict drove the branch through `tee`, and the commit station's message went straight
   into a file. Neither works now, because both files would hold JSON.

   Add one helper near the top of `run.sh`, and use it wherever the line needs a machine's words:

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
   one event rather than trying to reassemble the streamed fragments. Note that it returns the text of
   *every* assistant message in the run, one per line, so a station that narrated a step before
   answering puts that narration above its answer. This is the second time the anchored `^VERDICT:` from
   lesson 007 earns its place, and it is worth saying so: the verdict is now reliably somewhere in the
   findings file rather than reliably at the top of it. `run.sh` is now a program reading
   another program's output, which it has been pretending not to be since the `grep` in lesson 007.

4. **Ask the record what the last run cost.** This is the point of the lesson, so do it immediately
   rather than at the end. From the repository root:

   ```sh
   jq -r 'select(.type=="tool_execution_start") | .toolName' \
     factory/refactor/events/*.jsonl | sort | uniq -c

   jq -s '[.[] | select(.type=="message_end") | .message.usage.cost.total? // 0] | add' \
     factory/refactor/events/*.jsonl
   ```

   What it did, and what it cost. Both questions from the previous lesson's pressure test, from a run
   nobody watched, answered by two commands over files the line wrote to itself.

   Have the learner run these against a fresh run before going on. A record they have never queried is
   a record they have no reason to trust.

## What this costs

Run the line again and watch the terminal.

The readable output is gone. Where the doer used to explain what it was changing, JSON scrolls past.
The learner's terminal is now showing them strictly more information than it did yesterday, and they
can follow strictly less of it.

That is not an accident of formatting, and the fix is not to pick a prettier mode. A record and a view
are two different artefacts for two different readers, and the line has just traded one for the other.
The run they would most want to follow — the one going wrong right now — is the one they can no longer
watch.

Nothing is being taken away that the next lesson does not give back. The point is that they had to give
it up to get a record, and that getting it back is a separate job.

## Checks

From the repository root, run a fresh line and then inspect what it left behind:

```sh
./factory/refactor/run.sh
ls factory/refactor/events/
```

Verify by hand that:

- there is one `.jsonl` file per station per iteration, named for both;
- `.tmp/validate-findings.txt` still opens with `VERDICT: PASS` or `VERDICT: FAIL` on its first non-empty
  line, and the branch still routes on it;
- `git log -1` shows a commit message with no JSON in it;
- the two `jq` queries above return a plausible tool tally and a cost; and
- the terminal, during the run, is unreadable.

The last one is the finding, not a defect. Measure it if the learner is unconvinced:

```sh
wc -l factory/refactor/events/*.jsonl
```

## Pressure test

The learner can now say what the line did and what it cost — afterwards.

While it runs they are blind. `jq` answers questions about a file that has stopped growing; the run in
progress is the one nobody can see, and it is the only one they could still do anything about.

The record is being written live. Nothing is reading it live.
