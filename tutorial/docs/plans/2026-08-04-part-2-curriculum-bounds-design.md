# Part 2 curriculum bounds design

## Goal

Set the bounds of Part 2: what the learner must end up able to do, which steps get them there, and
what is deliberately out of scope. Part 2 is the whole remaining road — there is no Part 3 — and each
step should be the size of a Part 1 lesson: one concept, one small artefact, scripts a learner can
read in a sitting.

## Where Part 1 leaves the learner

Named and demonstrated: agent as harness plus job to be done; headless; boundary as a deliberate
`--tools` choice; doer; validator; evidence against assertion; baseline and comparison; the harness as
deterministic code around a model call; context as the only thing that changed between two runs of
the same prompt; and *orchestrator* as the name for what they themselves were doing.

In hand: four files and two single-turn scripts under `factory/`, flat, with no loop anywhere, and one
verdict-shape contract that only a human has ever read.

Never seen, in any form: anything running twice without a human pressing something; criteria that
survive past one turn; any decision made by software about what runs next; state across turns; a
reason to stop; cost; a machine that can be spoken to while it works.

## End state

The learner is operating an assembly line of four stations, at least two harness configurations, with
the validation loop running unattended. They can start the line and watch it work — ongoing token
cost, which station is running, what it is doing — ask the running machine a question and have it
change course, and ask about what has happened on the line without reading the raw record themselves.

Their role at the end is **operator**, not builder of many lines. The line they oversee is the one
they built.

### Explicitly out of scope

**A second line.** `factory/` holds one folder throughout. The word *factory* is still worth defining
in 005 — a factory is the software containing one or more lines — but the learner never builds a
second, and 013 oversees an orchestrator that routes stations and iterations within a single line. The
point is made with one line; the README's Part 2 framing should claim no more than that.

**Rollback and commit-as-undo as a lesson of its own.** The commit station in 007 gives the line a
discardable unit of work as a side effect. Nothing further is built for it.

**A deterministic station as a built artefact.** Carried in prose instead: a station may be an agent, a
deterministic step, or an agent containing deterministic steps. The commit station is the natural place
to say it, since committing is deterministic and writing the message is not.

## Ordering principle

Part 1's spine was *you do it by hand before software does it*. Part 2's is **the pressure test earns
the next lesson**: every step exists because the previous step's ending left the learner with something
they can feel the absence of.

That is why autonomy arrives before observability here. Taking the pause off while the learner is still
blind is the strongest motivation the curriculum has for building an instrument — the line runs eleven
iterations unattended and they cannot say what it did or what it cost. Handing them the instrument
first would answer a question they had not yet asked.

### The chain

Each lesson's pressure test is the next lesson's reason to exist. Read down this column and Part 2's
order stops being a matter of taste.

| Ends | Leaving the learner with | Which 00N answers |
| --- | --- | --- |
| 005 | A validator that was *told* not to modify files, and holds the tool to ignore that. | 006 |
| 006 | A `FAIL` scrolls past and the next iteration is identical to the one a `PASS` would have produced. | 007 |
| 007 | The line stops every iteration and asks them whether to continue. It cannot decide it is finished. | 008 |
| 008 | It ran eleven iterations while they made coffee. What did it do? What did it cost? | 009 |
| 009 | They can now answer both questions — afterwards. While it runs they see *less* than before: the readable terminal became a JSON firehose. | 010 |
| 010 | Watching only works while they stand there, and it shows what a tool did, not whether the line is getting anywhere. | 011 |
| 011 | They can ask about what happened. Not about what is happening, and they cannot change its mind. | 012 |
| 012 | They can steer one machine. The thing choosing which machine runs next has no voice at all. | 013 |
| 013 | Judgement: the criteria might be wrong, and nothing on the line will ever tell them. | — |

Two of these want a demonstration rather than an assertion, in the way lesson 006's `grep` demo does
today:

- **005.** Have the learner add one line to `validate.md` telling the validator to create a file, run
  it, and find the file. The boundary was a sentence, and a sentence is not a boundary.
- **009.** `wc -l events/*.jsonl` after a handful of iterations. The number is the argument.

## Curriculum shape

| # | Lesson | Concept it buys | Builds |
| --- | --- | --- | --- |
| 005 | Join them into an assembly line | line / machine / factory / iteration; criteria that outlive a turn | `factory/refactor/`, `run.sh`, `success.md` |
| 006 | Put the validator on a read-only harness | a boundary you ask for is not a boundary you own | narrower `--tools`, evidence carried by the harness |
| 007 | Compose stations, and branch | routing on a verdict; the line is a shape you can extend | `repair.md`, a commit station |
| 008 | Take the pause off | the stop condition — the judgement 007 leaves with the learner | a stop rule; iteration state |
| 009 | Record what the line did | a machine's output has a reader, and choosing the reader changes the format | `--mode json`, `\| tee events/`, `jq` |
| 010 | Watch it while it runs | observability is a separate consumer of the same record | `watch.sh`, `tail -f` |
| 011 | Ask the factory what happened | the log is raw material like any other | `ask.sh` |
| 012 | Talk to a running machine | a headless agent is not sealed | `--mode rpc`, a fifo, `steer` |
| 013 | Oversee the orchestrator | what is left when the mechanical part is gone | — |

### Where things live

The line got its edge in 005. The operating tools get theirs in 010, one level up:

```text
factory/
  watch.sh          ← operating the factory; takes a line name, line-agnostic
  ask.sh            ←
  refactor/         ← the assembly line
    run.sh          ← the orchestrator
    do.sh  validate.sh  refactor.md  validate.md  repair.md  commit.md  success.md
    quality-before.txt  validate-findings.txt
    events/
```

This is 005's own move — *make the move first, then take the name* — applied a level up, and it is what
lets 013 name the factory without hand-waving. The lexicon defines a factory as the software containing
one or more lines and the orchestrator managing them; `watch.sh` and `ask.sh` are not what make it a
factory, they are how it is **operated**, which is the third verb in the lexicon's own definition.

The practical payoff: both take a line name as an argument and would work unchanged on a second line
that nobody builds. The absent second line becomes a cosmetic absence rather than a structural one.

### Line shape as it grows

```text
005   baseline → doer → validator → pause
006   baseline → doer → validator' → pause              (same shape, narrower station)
007   baseline → doer → validator → {FAIL → repair}
                                 → {PASS → commit} → pause
008   ... → stop condition → loop or exit                [no pause]
012   ... with a live input line throughout
```

## Lesson 005: Join them into an assembly line

As specified today, with one change: **its pressure test moves.**

The current spec ends by observing that the line does nothing with what the validator found, which
points straight at the branch. With 006 inserted before the branch, that observation is one lesson too
early. 005's pressure test becomes the validator's boundary: the learner told it not to modify files,
and it holds a `bash` tool with which it can ignore them. Independence that rests on a prompt is a
promise the machine makes to itself, and the line is about to be left alone with it.

Demonstrate rather than assert it. Have the learner add one line to `validate.md` — create a file
somewhere in `calculator/` — run the validator, and then find the file. Delete it, and remove the
line. Every other boundary in this tutorial has been drawn with `--tools`, and this one was drawn with
a sentence.

The findings-ignored observation moves down to 006's pressure test, unchanged in substance.

## Lesson 006: Put the validator on a read-only harness

The harness is a different configuration of Pi, not a different CLI.

Today the validator receives `read,grep,find,ls,bash` and its prompt forbids file-modifying shell
commands. The boundary is *requested*. Remove `bash` and the boundary is *structural* — the validator
cannot modify anything because it cannot execute anything.

Which raises the obvious problem: the validator needs `node scripts/quality.mjs` and `npm test`, and it
can no longer run them. Nor can it read the working-tree diff, which lesson 003 has it obtain with
`git diff`. The answer is the move lesson 003 already made with the baseline. The harness runs the
checks and carries all three outputs into the prompt:

```sh
(cd ../../calculator && git diff -- .) > working-diff.txt
(cd ../../calculator && npm test) > test-output.txt 2>&1 || true
(cd ../../calculator && node scripts/quality.mjs) > quality-after.txt || true
cat validate.md success.md quality-before.txt quality-after.txt test-output.txt working-diff.txt \
  | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \
  | tee validate-findings.txt
```

Same pattern, applied a second time, which is what makes it teachable rather than novel: the harness
carries the evidence to a machine that cannot reach for it. Note `git diff -- .`; `git diff` alone
reports the whole repository regardless of the directory it runs in.

State the trade precisely, because it is vaguer than it first looks and 013 depends on it. The
validator keeps `read,grep,find,ls`, so it can still search the calculator and follow a hunch through
the files. What it loses is the ability to **run** anything nobody anticipated — a check, a filtered
test run, a `git diff --stat`. Its evidence set is now closed, fixed in advance by whoever wrote the
script.

That closure is the guarantee and the limitation in one. If `success.md` names a criterion whose
evidence nobody thought to capture, the validator cannot go and get it: it will either say nothing
about that criterion or invent support for it. A criterion nobody can gather evidence for fails
forever, and only a person notices why.

The road not taken, worth one line in the lesson: Pi extensions can gate the `bash` tool per command
(`examples/extensions/confirm-destructive.ts` does this shape). That buys a richer boundary for
considerably more machinery, and a boundary enforced by removing a capability is easier to trust than
one enforced by inspecting each use of it.

**Pressure test:** the line runs in order and does nothing at all with what the validator found.

## Lesson 007: Compose stations, and branch

Two moves in one lesson, but the second is the first one's payoff.

The branch is the current 006 spec: read the verdict, and a `FAIL` routes the findings into a repair
turn. The anchored `grep -m1 -o '^VERDICT: \(PASS\|FAIL\)'` and the reasoning about why the anchor is
the whole of the parse's correctness carry over unchanged.

What is new is that a `PASS` now also goes somewhere. The `if` gains an `else`, and the else is a
fourth station that **writes the commit**. Given a passing verdict and the validator's findings, it
stages `calculator/` and writes a message describing what changed and why.

Three things that station buys, none of which needed a lesson of their own:

- the verdict acquires a consequence beyond routing — a `PASS` produces a durable artefact, a `FAIL`
  does not, and the difference is visible in `git log` rather than only in scrollback;
- the line gets a discardable unit of work, which is what makes unattended running survivable in 008;
- it is the natural place for the prose point that a station may be deterministic, or may contain
  deterministic steps. `git add` and `git commit` are deterministic; choosing what the message says is
  not. One station, both kinds of step.

A station is its job, its boundary, and its contract — not its tool, and not necessarily a model. The
lexicon says this already and the lesson should quote it: *"The internals can be a model call or
ordinary deterministic code; from the assembly line's point of view it makes no difference."*

Worth saying that the branch is not an extension of the concept either. The lexicon defines an assembly
line as machines "arranged as a directed graph… the graph may branch". This is the first lesson in
which the line becomes what the word has meant since 005.

### The commit station

Keep it small; this is a showcase, not a release process.

`commit.md` states one job: given the diff and the validator's findings, write the commit message for
the change that was just made. A subject line under 72 characters, a blank line, then two or three
lines on what changed and which success criteria it moved. It must not run anything, must not edit
anything, and must emit **only** the message — no preamble, no fences.

Its tools are `read,grep,find,ls`. It cannot commit, and it is not supposed to: the agent writes the
message and the script does the committing.

```sh
else
  echo "Starting commit..."
  cat commit.md success.md validate-findings.txt working-diff.txt \
    | (cd ../../calculator && pi --no-session --tools read,grep,find,ls -p) \
    > commit-message.txt
  (cd ../../calculator && git add -- . && git commit -q -F "$PWD/commit-message.txt")
fi
```

`run.sh` has already done `cd "$(dirname "$0")"`, so `$PWD` is the line's folder and `git -C`-style
gymnastics are unnecessary. It commits to whatever branch the learner's clone is on and stages
`calculator/` only; `factory/` is gitignored, so nothing they wrote by hand is ever swept in, and no
branch management is needed for the point to land.

That is the "one station, both kinds of step" claim made concrete in four lines: a model call decides
what to say, and ordinary code does the irreversible part.

**One thing worth pointing at, because 007 is the format-contract lesson.** This output goes straight
into `git commit -F`. If the machine opens with "Here's the commit message:", that sentence is now in
the repository's history. The verdict contract in the branch above is defended by a `^` anchor; this
one is defended by nothing at all. Same kind of promise between a machine that writes and a machine
that reads, one of them load-bearing and unprotected — and unlike a misrouted verdict, this failure is
permanent and visible in `git log`.

**Pressure test:** the line stops for the learner every iteration, and the learner is still the one
deciding whether there should be another.

## Lesson 008: Take the pause off

The `read` goes, and the loop must now decide for itself when to stop. This is the first lesson in
either part where the line holds state across iterations.

It is also `run.sh` taking on the last responsibility the lexicon assigns to an orchestrator — the role
is "starting a line, handing each machine its inputs, choosing what runs next where the graph branches,
handling failures and retries, and deciding when the line is finished." 007 gave it the branch; this
gives it the ending. Nothing new is being invented, which is worth saying, because 013 then has nothing
left to hand over.

Three stopping conditions worth having the learner choose between, because each fails differently:

- a fixed iteration count — honest, crude, and never wrong about terminating;
- a budget — the record already carries per-message cost, so the line can stop when it has spent
  enough;
- no observable progress — compare this iteration's quality report with the last one and stop when
  nothing moved.

The third is the one that teaches: it requires the line to remember the previous iteration, which
nothing in Part 1 or Part 2 has needed until now.

**Pressure test:** it ran eleven iterations while the learner made coffee. Ask them what it did, and
what it cost. Neither question has an answer.

## Lesson 009: Record what the line did

`--mode json` on each Pi invocation, and `| tee events/<iteration>-<station>.jsonl`. Two edits, both of
which the learner has made before — a flag, and a `tee`.

Stdout stops being prose for a human and becomes a JSONL event stream: `agent_start`, `turn_end`,
`tool_execution_start`, `message_end`, each assistant message carrying `usage.cost`. `jq` arrives here,
used once over a finished file, and it answers 008's pressure test outright:

```sh
jq -r 'select(.type=="tool_execution_start") | .toolName' events/*.jsonl | sort | uniq -c
jq -s 'map(.message.usage.cost.total // 0) | add' events/*.jsonl
```

What it did, and what it cost. Both questions, from a run nobody watched.

The teaching beat is that a machine's output has a reader, and choosing the reader changes the format.
Everything the line printed until now was for a human standing at the terminal.

**Be explicit that this is a trade, not an upgrade.** They have gained a record and lost their view.
The terminal that used to scroll readable agent output now scrolls JSON, and the run they would most
want to understand — the one going wrong right now — is the one they can no longer follow. Nothing was
taken away that the next lesson will not give back; the point is that they had to give it up to get a
record, and that a record and a view are two different things serving two different readers.

**Pressure test:** they can answer both questions afterwards, and while it runs they can see less than
they could yesterday.

## Lesson 010: Watch it while it runs

The second terminal, and `tail -f` in front of the `jq` they already know. `watch.sh` lands at
`factory/` level rather than inside the line, takes the line's name as an argument, and is about five
lines:

```sh
cd "$(dirname "$0")"
tail -f -n +1 "${1:?usage: watch.sh <line>}"/events/*.jsonl \
  | jq -r --unbuffered 'select(.type=="tool_execution_start") | "→ \(.toolName)"'
```

and a running cost total is a second expression over `usage.cost.total`.

The only new idea is *live*. `jq` is a lesson old, the record is a lesson old, and the entire change is
that the file is read as it grows rather than after it stops. That is the cheapest possible way to
show the shape of the concept, which is that **observability is a separate consumer of the same
record**: the line does not know it is being watched, nothing inside it changed to permit watching, and
a second watcher could be attached without touching it. Contrast that with 009, where getting the
record at all required editing every station.

**Pressure test:** watching only works while they stand there, and it tells them which tool ran — not
whether the line is getting anywhere.

## Lesson 011: Ask the factory what happened

```sh
cat refactor/events/*.jsonl | pi -p "What happened on this line, and what did it cost?"
```

Lesson 001's command, unchanged in shape, pointed at the factory's own record instead of at the
calculator. Same harness, same job on stdin, same read-only boundary. No new moving parts at all,
which is the lesson: the line's output is raw material like any other, and an agent reads it the way
the first agent they ever ran read the calculator.

This is where the tutorial closes its own loop, and it should say so.

**Pressure test:** they can ask about what happened. They cannot ask about what is happening, and they
cannot change its mind.

## Lesson 012: Talk to a running machine

`--mode rpc`. Stdin stops being the prompt and becomes a command channel; the process stays alive; the
learner sends `{"type":"steer","message":"..."}` and it is delivered after the current turn's tool
calls, before the next model call.

**This stays in bash, and no daemon is needed.** Both of those look like they should be false, and the
reason they are not is the second terminal from 010.

The control channel is a named pipe:

```sh
mkfifo control
pi --mode rpc --no-session --tools read,edit,write,grep,find,ls < control \
  > events/steerable.jsonl &
sleep infinity > control &          # holder: see below
jq -Rn --arg m "$(cat refactor.md success.md)" '{type:"prompt",message:$m}' > control
```

and steering, from the terminal already open next to it:

```sh
jq -Rn --arg m "Stop refactoring the parser, work on the formatter" \
  '{type:"steer",message:$m}' > control
```

`jq` writes the command here rather than reading events, which is worth pointing out: it is the same
tool doing the inverse job, and it is the only correct way to build that JSON, because a learner who
types an apostrophe into a hand-rolled `echo '{"message":"..."}'` gets a parse error instead of a
steer.

Nothing needs to be concurrent inside any one script, which is what kept this in bash. Terminal 1 runs
the line. Terminal 2 watches it with `watch.sh`. Steering is a one-line command in either. Each
terminal does exactly one blocking thing, and the awkward case — a single script that must read the
learner's typing *and* wait for `agent_end` at the same time — never arises.

**Two things the lesson has to be honest about:**

- **The holder.** A fifo returns EOF when its last writer closes, so `pi --mode rpc < control` would
  exit the moment the first `jq` finished writing. `sleep infinity > control &` is a process whose only
  job is to keep the channel open. It is the strangest line in Part 2, and it earns its place: it makes
  the learner see that a channel to a running process needs somebody holding it, which is the entire
  reason daemons exist. They are building the smallest possible one.
- **Cleanup.** Two background pids and a fifo to remove, which means a `trap`. Say so rather than
  leaking processes into the learner's session.

No daemon is required because there is nothing to bridge. A daemon exists to connect a short-lived CLI
to a handle held in some other process; here the handle is a path on disk, and any terminal that can
write to a file can reach it.

**Ruled out:** the package also exports a typed `RpcClient` (`start`, `stop`, `prompt`, `steer`,
`onEvent`, `getSessionStats`), which would make this a dozen lines of Node. It is genuinely nicer code
and it is the wrong choice here — it would change the tutorial's language at lesson eleven of thirteen
to avoid one odd line, and it would turn *how do you talk to a running process* into a library call the
learner cannot see through. Worth one sentence in the lesson as the thing they would reach for outside
a tutorial.

**Pressure test:** they can steer one machine. The thing deciding which machine runs next has no voice
at all.

## Lesson 013: Oversee the orchestrator

The terminal lesson, and the one where the learner's role is named. Everything mechanical has moved
into software: routing, carrying evidence, stopping, recording, reporting. What is left is theirs.

**Nothing is handed over.** The learner has had the orchestrator since 007 — `run.sh` is the thing that
decides which machine runs next, and the current lesson 006 spec already says so in those words. 008
gave it the last responsibility the lexicon assigns to the role, *deciding when the line is finished*.
The factory is the folder it all lives in, and the scripts that make it operable are the ones the
learner wrote in 010 and 011.

So this lesson builds nothing. It names what is already there and then asks what is left, which is the
same shape as 005 — make the move first, then take the name — and the same shape as lesson 004, which
also built nothing and is the strongest lesson in Part 1.

The lesson's content is the residue: watching cost accrue and deciding it is too
much; steering a machine that has misread its job; stopping a line that is converging on the wrong
thing; and the judgement nothing on the line can make — that `success.md` itself is wrong.

006 is what makes that last one concrete rather than philosophical. Closing the validator's evidence
set bought a boundary that holds without being asked, and the price was that the evidence has to be
anticipated. A criterion whose evidence nobody captured will fail every iteration, forever, and the
line's only response is to repair towards it again. Nothing in the record says *this criterion is
unreachable* — it says `[FAIL]`, the same way it would for a criterion the doer simply has not met
yet. Telling those two apart is the operator's job, and it is the last thing to have no machine.

## Ledger and engine changes

`docs/specs/README.md` gains seven rows under Part 2, replacing the current two.

`evals/scenarios/` needs `lesson-007` through `lesson-013`, and the existing `lesson-005` and
`lesson-006` are re-scoped: 006 is no longer the branch lesson. `evals/harness/assertions.ts` asserts
on exact script text, exact Pi argument lists and exact echo strings, so every change above lands
there — in particular 006's `--tools` narrowing and the new evidence-capture lines, 009's `--mode json`
and `tee`, and 012's fifo, holder and `trap`.

Part 2 introduces exactly three tools the learner has not used: `jq`, `mkfifo`, and `tail -f`. Every
script in it is bash, as in Part 1.

No change is needed to `readProgress`; it already parses `## Part N — <title>` headings.

## Size

Nine lessons against Part 1's four. Part 2 is roughly twice Part 1, and that is after cutting a second
line, rollback, and a deterministic station. The two-part framing survives; the claim that each part is
a comparable piece of homework does not, and the README should stop implying it.
