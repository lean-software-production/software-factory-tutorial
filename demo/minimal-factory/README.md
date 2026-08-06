# The smallest factory that is still a factory

One command. Four agents on the line, one watching it. Two stations with no model
in them. A loop that repairs its own work, a cap that stops it trying forever, and
a commit at the end if the work was any good.

```sh
./factory ../../calculator/src/index.ts
```

```
factory calculator/src/index.ts
        clean tree · pi 0.83.0 (node_modules/.bin/pi) · jq 1.8.2

line    src/index.ts · cap 5 rounds
│
├─ baseline       deterministic
│                 ✓ Tests 9 passed (9)              1.8s
│
├─ doer           claude-opus-4-7 · read,edit,write,grep,find,ls,run_tests
│                 ✓ 23.5k tok · $0.07               41.2s
│                 extracted tokenising into a named helper
│
├─ scope-guard    deterministic
│                 ✓ nothing outside the target      0.0s
│
├─ round 1/5
│  ├─ tests          deterministic
│  │                 ✓ Tests 9 passed (9)           1.8s
│  ├─ validator      claude-opus-4-7 · read,grep,find,ls
│  │                 ✓ 4.6k tok · $0.03             16.2s
│  │                 PASS
│
├─ committer      claude-opus-4-7 · read,grep,find,ls
│                 ✓ 3.9k tok · $0.01                 8.0s
│                 8060660 Extract tokenisation into a `tokenise` helper
│

  4 model calls · $0.12 · 1 round · 1m 12s
  records in demo/minimal-factory/run/events
  ✓ the line ran to a commit
```

**Node 24.2 or newer.** The calculator's own test suite fails on Node 23 — an
experimental-feature warning on stderr trips an assertion — and this line judges
every change by whether that suite passes, so an old Node makes every round fail
for a reason no station can fix. The line checks before it spends anything.

If you use a version manager, pin it somewhere the *whole repository* is under.
The failing test spawns `npx` with its working directory at the repository root,
so a pin inside this folder never reaches the process that matters.

This is a demo, not a lesson. Part 2 of the tutorial builds each of these pieces
one at a time and explains why each is shaped the way it is; this builds all of
them at once, badly, so you can see the shape. It is not a substitute for either.

## The shape

```
factory ─► orchestrator ─► baseline ─► doer ─► scope-guard ─┐
                                                            │
                    ┌───── healer ◄──── FAIL ───────────────┤
                    │                                       │
                    └─► scope-guard ─► tests ─► validator ──┤
                                                            │
                                       PASS ─► committer ─► git
```

Up to **5 validation rounds**. Round 1 judges the doer's work; rounds 2–5 each
judge a healer's. A FAIL on the last round gives up, commits nothing, and tells
you how to discard the change.

**The factory and the line have different jobs.** The factory checks what it owns
— the argument names a file, the file is inside `calculator/`, the tree is clean,
the tools exist — and then hands off. It does not `exec`; it stays, and the last
line of a run is the factory saying how the run went.

Everything after that belongs to the line, including whether the line can start.
The suite has to be green before anyone touches anything, and that is the line's
own standard checked by the line's own station, so it happens on the rail with
every other station rather than in the factory's preflight.

## What is actually going on

**An agent's output is another agent's input.** Two different ways, and the
difference matters. The validator's findings reach the healer as *text*, piped
into its prompt. The doer's work reaches the validator as a *mutation of the git
repository*, read back out as a diff. Same line, two kinds of handoff.

**A harness is a directory.** Each of `harnesses/doer`, `validator`, `healer`
and `committer` holds exactly two files:

- `prompt.md` — the job
- `flags` — which tools the agent may call, which model it runs on, and whether
  its result needs summarising

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

## Stations and instruments

They are different kinds of thing, and the difference is worth a directory.

A **station** moves the work forward. Take one out and the commit differs. Those
live in `harnesses/`.

An **instrument** reads the line's own record and tells you about it. Take one
out and the commit is byte-identical. Those live in `instruments/`.

`instruments/summariser` is the only one so far. It compresses what the doer or
the healer said into the eight-to-twelve words you see on the rail. Its harness
has `TOOLS=""` — no read, no edit, no shell, no way to reach the repository at
all. It sees the text it is handed and nothing else, which makes "an instrument
cannot touch the product" a fact about its harness rather than a promise in its
prompt. It runs on Haiku, because compressing a paragraph is not the hard part of
this line and it happens between stations a human is waiting on.

**Only two stations are summarised.** `SUMMARISE` is a per-harness flag and three
of the four say no:

| Station | Its summary | From |
| --- | --- | --- |
| test-runner | `Tests 9 passed (9)` | vitest |
| validator | `PASS` / `FAIL` | the parsed verdict |
| committer | `8060660 Extract tokenisation…` | `git log -1` |
| **doer, healer** | prose about a change | **the summariser** |

Three of those are facts the line already holds. Paying a model to describe what
`git` can state is paying twice for one answer.

The summariser's own events land in `run/events/` with everyone else's, so the
total at the end includes what the watching cost. An instrument you are not
billed for is an instrument you have stopped counting.

## Watching a station spend

While a station runs, the status line under it updates about once a second:

```
│  ⠹ doer… · 16k tok · $0.021 · edit
```

`--mode json` flushes each event as it happens, so the record is readable while
the station writing it is still running. You do not have to wait for a station to
finish to learn what it has cost, and `tool_execution_start` names what it is
doing right now — over one doer run that reads
`read → read → edit → read → run_tests`.

The counting is the one subtle part, and `lib/live-of.sh` carries the note.
`message_update` events are successive *snapshots of the same message*, so
summing them would count one message a dozen times over. What is true is that
every ended message is final and the message in flight is worth its latest
snapshot — so the tally is a completed total plus one live figure, reset at each
`message_end`.

## The rail

An earlier version printed `orchestrator → doer` on the way out and
`doer → orchestrator` on the way back, for every station. Half the output was
arrows, and the return arrow never carried information — it fired whether or not
anything had gone well, so it only ever said the run had not crashed.

The rail says the same thing structurally. `├─` is a station hanging off a line
that is still running; the line continuing past it is the handoff back. A round
draws its stations *inside* itself, so the shape of a five-round run is visible
without reading any of the words — which is the case the arrows handled worst.

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
| `factory` | The entry point. Checks what it owns, hands off, waits, reports. Nothing here calls a model — a preflight that costs money is a preflight you skip. |
| `orchestrator` | The line. Runs no model itself; every decision it makes comes from a file some station wrote. |
| `criteria.md` | The four things a good change has to be. Every station gets these. |
| `harnesses/*/` | One directory per station: `prompt.md` and `flags`. |
| `instruments/*/` | One directory per instrument. Same shape, no effect on the product. |
| `stations/test-runner` | Runs `npm test`, writes a report, always exits 0. A failing test is a result, not an error. |
| `stations/scope-guard` | Puts back anything touched outside the target. |
| `extensions/run-tests-tool.ts` | The `run_tests` tool. Loaded via `-e`; `pi` handles the TypeScript through jiti, so there is no build step. |
| `lib/station.sh` | The only `pi` invocation. |
| `lib/say.sh` | The rail, the status line, the clock. |
| `lib/live-of.sh` | What a station has spent *so far*, read from the record while it is still being written. |
| `lib/*.sh` | One script per question: what did it say, what did it cost, how many tokens, which way does it branch, what is this material. |
| `run/` | Everything a run writes about itself. Gitignored, wiped at the start of each run. |

## Which pi it uses

`lib/paths.sh` prefers `node_modules/.bin/pi` — the version `package.json` pins —
and falls back to whatever is on `PATH`.

That is not fussiness. A version manager pins tools per language runtime, so
changing the Node this repository uses can silently change, or remove, the `pi`
it gets. This demo was built against 0.83; on 0.74 it fails on an unknown flag,
and on a model catalogue three versions out of date. Using the pinned one means
the demo no longer depends on which `pi` your shell happens to resolve.

## Running it cheaply

The harnesses are pinned to `anthropic/claude-opus-4-7` — the newest Opus in both
0.74's and 0.83's catalogue, so the pin survives either. To watch the wiring work
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

A clean run is three station calls plus one from the summariser. Measured on this
calculator: about **$0.12** on Opus 4.7, **$0.06** on Haiku 4.5. A run that heals
costs a round more each time, and the worst case the cap allows is eleven calls.

The total is printed at the end of every run, and the per-station cost and
elapsed time as each one finishes. All of it comes out of the `--mode json` event
records in `run/events/`, which stay there afterwards for you to query.

## Where it commits

Into **this repository, on your current branch**, staging `calculator/` only.
`factory` refuses to start if `calculator/` is dirty, because the commit stages
that whole directory and would otherwise sweep up your work as though a station
had done it.

To undo a run: `git reset --soft HEAD~1`, then `git restore --staged --worktree -- calculator`.

## What this demo does not have

Part 2 of the tutorial builds all of these properly; the demo skips every one.

- **No live transcript.** The status line tells you what a running station has
  spent and which tool it is in, but not what it is *saying*. The words arrive
  when it finishes.
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
