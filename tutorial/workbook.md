---
parts:
  - id: validation-loop
    lessons:
      - 001-run-an-agent-headlessly
      - 002-build-a-doer
      - 003-build-a-validator
      - 004-feed-the-findings-back
  - id: build-the-factory
    lessons:
      - 005-join-them-into-a-line
      - 006-read-only-validator
      - 007-compose-and-branch
      - 008-take-the-pause-off
      - 009-record-what-happened
      - 010-watch-it-while-it-runs
      - 011-ask-what-happened
      - 012-talk-to-a-station
      - 013-oversee-the-orchestrator
---

# Software Factory Tutorial

Welcome! 👋

We're going to build our own software factory, step by step, from fundamental building blocks.

We'll start out in **part 1** by running each piece of the factory by hand, then we'll plug
things together into an automated assembly line in **part 2**.

Here is the route:

- **Part 1 — The validation loop.** Run an agent by hand, then build a doer and a validator that
  check each other's work, and close the loop so a failing verdict sends the doer back around.
- **Part 2 — Build the factory.** Join that loop into an ordered line, give it branching, a
  record, a watcher, a way to ask it questions and talk to a running station, and finish by
  naming what you built and what is still yours to judge.

Ready to get started?
