# Glossary

The words this tutorial teaches, and the lesson each one arrives in. Every term is introduced by a
lesson and defined there; this page says where, so a specification can use a word without redefining
it and an author can see what is already spoken for.

A later lesson's vocabulary belongs to that lesson. Lesson 001 has no *station*, because a learner
who has not yet joined anything has no referent for one.

## Part 1 — The validation loop

| Term | What it is | Introduced in |
| --- | --- | --- |
| **agent** | A harness with a job to be done. | [001](../lessons/01-the-validation-loop/01-run-an-agent-headlessly/lesson.md) |
| **harness** | The ordinary software around a model: it prepares the input, calls the model, and handles what comes back. | [001](../lessons/01-the-validation-loop/01-run-an-agent-headlessly/lesson.md) |
| **job to be done** | What you hand an agent. | [001](../lessons/01-the-validation-loop/01-run-an-agent-headlessly/lesson.md) |
| **doer** | The agent that does the job and produces the work product. | [002](../lessons/01-the-validation-loop/02-build-a-doer/lesson.md) |
| **validator** | The agent that verifies the job was done satisfactorily, given the work and the criteria. | [003](../lessons/01-the-validation-loop/03-build-a-validator/lesson.md) |

## Part 2 — Build the factory

| Term | What it is | Introduced in |
| --- | --- | --- |
| **assembly line** | An ordered sequence of stations, each station's output feeding the next. | [005](../lessons/02-build-the-factory/01-join-them-into-a-line/lesson.md) |
| **station** | An agent running in a non-interactive harness — handed its inputs, run to completion, no human in the conversation. Its internals may be a model call or ordinary deterministic code. | [005](../lessons/02-build-the-factory/01-join-them-into-a-line/lesson.md), sharpened in [007](../lessons/02-build-the-factory/03-compose-and-branch/lesson.md) |
| **iteration** | One turn of the line: the bounded batch of agent work between check-ins. | [005](../lessons/02-build-the-factory/01-join-them-into-a-line/lesson.md) |
| **orchestrator** | Whatever decides which station runs next, handles failures, and decides when the line is finished. In lesson 004 it is the learner; from 007 it is `run.sh`. | [007](../lessons/02-build-the-factory/03-compose-and-branch/lesson.md) |
| **record** | The JSON event log a station writes instead of printing for a human — one JSONL file per station per iteration, and what later stations and tools query instead of a terminal. | [009](../lessons/02-build-the-factory/05-record-what-happened/lesson.md) |
| **factory** | The software containing one or more assembly lines and their orchestrator(s) — the unit built, deployed, and operated. | [005](../lessons/02-build-the-factory/01-join-them-into-a-line/lesson.md), expanded in [010](../lessons/02-build-the-factory/06-watch-it-while-it-runs/lesson.md) |
| **operator** | The person who runs, watches, and asks questions of the factory from outside it, using `watch.sh`, `ask.sh`, and `steer.sh`, rather than performing a station's job by hand. | [013](../lessons/02-build-the-factory/09-oversee-the-orchestrator/lesson.md) |

## Words this tutorial does not use

Some of these name the same roles elsewhere in the industry, and an earlier draft of this tutorial
used several of them. They are listed so a rename does not quietly reverse.

| Instead of | Use | Why |
| --- | --- | --- |
| reviewer, critic, verifier, agent B | **validator** | One canonical name for the role, taught once. |
| worker, agent A | **doer** | As above. |
| machine | **station** | A station is its job, its boundary, and its contract — not its tool, and not necessarily a model. One word for the thing, whatever its internals. |
| iteration, for a unit of curriculum | **lesson** | *Iteration* means a turn of the line. `docs/specs/NNN-*.md` is a lesson. |

*Machine* is still the right word for a computer — "reach the tutor from another machine" — and
*machinery* is unrelated. Neither is a station.
