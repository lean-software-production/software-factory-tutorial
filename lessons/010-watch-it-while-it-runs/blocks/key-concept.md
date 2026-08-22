---
type: narrative
---

## Key concept

The only new idea in this lesson is *live*. `jq` is a lesson old, the record is a lesson old, and
the
entire change is that the file is read as it grows rather than after it stops.

That small change makes a large point. **Observability is a separate consumer of the same record.**
The
line does not know it is being watched. Nothing inside it changes to permit watching. A second
watcher,
asking a different question, could be attached without touching a single station.

Contrast that with the previous lesson, where getting the record at all meant editing every station
on
the line. Producing a record is invasive and you do it once; consuming one is free and you do it as
often as you like. That asymmetry is why the record was worth the view it cost.

The watcher also belongs somewhere new. `run.sh` is the orchestrator and lives inside the line,
because
it can only run that line. A watcher can watch any line, so it lives one level up:

```text
factory/
  watch.sh          ← operating the factory
  refactor/         ← the assembly line
    run.sh          ← the orchestrator
    ...
    .tmp/events/
```

A **factory** is the software containing one or more assembly lines and the orchestrator that
manages
them — the unit you build, deploy and **operate**. `watch.sh` is not what makes this a factory. It
is
how one is operated, and putting it beside the line rather than inside it is what makes the
difference
visible on disk. Lesson 005 gave the line an edge before naming it; this is the same move, one level
up.
