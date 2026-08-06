# Watch it while it runs

Read the record as it grows, from a terminal the line knows nothing about.

## Key concept

The only new idea in this lesson is *live*. `jq` is a lesson old, the record is a lesson old, and the
entire change is that the file is read as it grows rather than after it stops.

That small change makes a large point. **Observability is a separate consumer of the same record.** The
line does not know it is being watched. Nothing inside it changes to permit watching. A second watcher,
asking a different question, could be attached without touching a single station.

Contrast that with the previous lesson, where getting the record at all meant editing every station on
the line. Producing a record is invasive and you do it once; consuming one is free and you do it as
often as you like. That asymmetry is why the record was worth the view it cost.

The watcher also belongs somewhere new. `run.sh` is the orchestrator and lives inside the line, because
it can only run that line. A watcher can watch any line, so it lives one level up:

```text
factory/
  watch.sh          ← operating the factory
  refactor/         ← the assembly line
    run.sh          ← the orchestrator
    ...
    .tmp/events/
```

A **factory** is the software containing one or more assembly lines and the orchestrator that manages
them — the unit you build, deploy and **operate**. `watch.sh` is not what makes this a factory. It is
how one is operated, and putting it beside the line rather than inside it is what makes the difference
visible on disk. Lesson 005 gave the line an edge before naming it; this is the same move, one level
up.

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

   `-n +1` starts from the beginning of each file rather than the last ten lines, so a watcher attached
   late still shows the whole run. `--unbuffered` makes `jq` emit each line as it arrives instead of
   holding output back until its buffer fills, which is the difference between watching a line and
   watching nothing for thirty seconds and then everything at once.

   The line's name is an argument, not a constant. This watcher would work unchanged on a second line
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
   firehose, and the one watching it is a list of what the stations are doing. Neither script knows the
   other exists.

3. **Add the running cost.** A second expression over the same stream, either as a second watcher in a
   third terminal or as a flag on the first:

   ```sh
   tail -f -n +1 "$line"/events/*.jsonl \
     | jq -r --unbuffered '
         select(.type=="message_end")
         | .message.usage.cost.total? // empty
         | "cost +\(.)"'
   ```

   Two consumers, one record, no coordination between them. That is the property the lesson is for.

## Checks

From the repository root, with the line running in another terminal:

```sh
./factory/watch.sh refactor
```

Verify by hand that:

- output appears while the line is still working, not after it finishes;
- the tool names shown correspond to what the stations are actually doing — file reads during
  validation, edits during a doer turn;
- stopping the watcher with Ctrl-C does not affect the run at all;
- starting a second watcher alongside the first works, and neither interferes with the other; and
- `./factory/watch.sh` with no argument fails with the usage message rather than doing something
  surprising.

## Pressure test

The learner can see the line working, and only while they are standing in front of it.

Look at what the watcher actually says. It says `→ read`, `→ edit`, `→ bash`. It reports which tool ran,
which is a fact about the machinery and not about the work. It cannot say whether this iteration is
better than the last one, whether the doer has understood its job, or whether the line is converging on
anything at all.

A firehose is not an answer to a question, and the learner still has to be present to drink from it.

There is a record sitting on disk that contains everything they would need to answer a real question
about this run. Reading it themselves is what they have been doing all lesson. The next lesson gives
that job to something better at it.
