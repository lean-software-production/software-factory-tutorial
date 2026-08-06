# The smallest factory that is still a factory

One command. Four agents, each on its own harness. Two stations with no model in
them. A loop that repairs its own work, a cap that stops it trying forever, and a
commit at the end if the work was any good.

```sh
./factory ../../calculator/src/index.ts
```

This is a demo, not a lesson. The tutorial in `docs/specs/` builds each of these
pieces one at a time and explains why each one is shaped the way it is; this
builds all of them at once, badly, so you can see the shape. Read it *after*
Part 1, or alongside Part 2. It is not a substitute for either.

## The shape

```
factory ─► orchestrator ─► doer ─► scope-guard ─► test-runner ─► validator ─┐
                                                                            │
                            ┌───── healer ◄──── FAIL ──────────────────────┤
                            │                                              │
                            └─► scope-guard ─► test-runner ─► validator ─►─┘
                                                                            │
                                                       PASS ─► committer ─► git
```

Up to **5 validation rounds**. Round 1 judges the doer's work; rounds 2–5 each
judge a healer's. A FAIL on the last round gives up, commits nothing, and tells
you how to discard the change.

## What is actually going on

**An agent's output is another agent's input.** Two different ways, and the
difference matters. The validator's findings reach the healer as *text*, piped
into its prompt. The doer's work reaches the validator as a *mutation of the git
repository*, read back out as a diff. Same line, two kinds of handoff.

**A harness is a directory.** Each of `harnesses/doer`, `validator`, `healer`
and `committer` holds exactly two files:

- `prompt.md` — the job
- `flags` — which tools the agent may call, and which model it runs on

That is the whole of what makes one station different from another.
`lib/station.sh` is the only place this demo invokes `pi`, and it does not know
which station it is running.

**Boundaries are drawn two ways, and only one of them holds.**

The validator has no `edit`, no `write`, and no way to run anything. That
boundary is a *fact* — the tool is not in its harness, so there is nothing to
respect or ignore.

"Change only one file" cannot be drawn that way, because the tool that edits the
target is the same tool that edits everything else. So it is a *request*, and
requests get ignored. During the build of this demo, a healer that could not make
the tests pass rewrote `package.json`, created three new files, and explained at
length why that was the correct thing to do. `stations/scope-guard` exists
because of that run: after every writing station, deterministically, anything
outside the target file is put back.

If you take one thing from this demo, take that one.

**Two stations have no model in them.** `test-runner` runs the calculator's suite
and writes down what happened. `scope-guard` reverts what strayed. Neither has an
opinion, which is exactly why the validator's judgement is worth reading — the
facts it judges were not produced by anything with a stake in the verdict.

## The `run_tests` tool

The doer and the healer can run the tests. They cannot run *anything else*, and
that is not enforced by inspecting what they asked to run.

`pi` will let you restrict `bash` — a `tool_call` hook can read
`event.input.command` and block it. Don't. Deciding whether a shell string is
safe means parsing shell, and `npm test; curl evil.example` beats any allowlist
written as string matching.

`extensions/run-tests-tool.ts` registers a custom tool instead. It takes **no
parameters at all**, so there is no command for a model to widen, and it runs
exactly one script: the same `stations/test-runner` the orchestrator runs. An
allowlist by construction rather than by inspection.

## Files

| Path | What it is |
| --- | --- |
| `factory` | The preflight. One argument, a file inside `calculator/`, a clean tree, the tools present. Nothing here calls a model — a preflight that costs money is a preflight you skip. |
| `orchestrator` | The loop. Runs no model itself; every decision it makes comes from a file some station wrote. |
| `criteria.md` | The four things a good change has to be. Every station gets these. |
| `harnesses/*/` | One directory per agent: `prompt.md` and `flags`. |
| `stations/test-runner` | Runs `npm test`, writes a report, always exits 0. A failing test is a result, not an error. |
| `stations/scope-guard` | Puts back anything touched outside the target. |
| `extensions/run-tests-tool.ts` | The `run_tests` tool. Loaded via `-e`; `pi` handles the TypeScript through jiti, so there is no build step. |
| `lib/station.sh` | The only `pi` invocation. |
| `lib/*.sh` | One script per question: what did it say, what did it cost, how many tokens, which way does it branch, what is this material. |
| `run/` | Everything a run writes about itself. Gitignored, wiped at the start of each run. |

## Running it cheaply

The harnesses are pinned to `anthropic/claude-opus-5`. To watch the wiring work
without paying frontier prices for it:

```sh
FACTORY_MODEL=anthropic/claude-haiku-4-5 FACTORY_MAX_ROUNDS=2 ./factory ../../calculator/src/index.ts
```

The pin in `flags` stays the default. What comes out of a cheap run is worth
less; what it costs to find out the plumbing is connected is worth less too.

`FACTORY_STATION_TIMEOUT` (default `10m`) bounds a single station. `pi` has no
turn or token cap, and a station that cannot solve its problem does not stop — it
keeps trying. The healer mentioned above spent 1.06M tokens before the round cap
caught it. Wall-clock is a crude bound and it is the only one available.

## What it costs

A clean run is three model calls. Measured on this calculator: **$0.13** on
Opus 5, **$0.05** on Haiku 4.5. A run that heals costs more per round, and the
worst case the cap allows is ten calls.

The total is printed at the end of every run, and the per-station cost as each
one finishes. Both come out of the `--mode json` event records in `run/events/`,
which stay there afterwards for you to query.

## Where it commits

Into **this repository, on your current branch**, staging `calculator/` only.
`factory` refuses to start if `calculator/` is dirty, because the commit stages
that whole directory and would otherwise sweep up your work as though a station
had done it.

To undo a run: `git reset --soft HEAD~1`, then `git restore --staged --worktree -- calculator`.

## What this demo does not have

Part 2 of the tutorial builds all of these properly; the demo skips every one.

- **No live view.** You see a station start and finish. What it is doing while it
  runs is invisible until it is over.
- **No steering.** A station that has started cannot be redirected, only waited
  out or timed out.
- **No ledger.** The events are on disk and nothing asks them anything except the
  cost and token totals.
- **No read boundary.** `--tools` controls *which* tools a station has, not what
  paths they reach. Every station here can read anything the user running it can
  read — one of them found and read this demo's own source mid-run. `pi` ships no
  sandbox; containment is the container's job, not the harness's.
- **One routing decision.** PASS or FAIL, one branch point. Calling this a
  "topology" is generous.
