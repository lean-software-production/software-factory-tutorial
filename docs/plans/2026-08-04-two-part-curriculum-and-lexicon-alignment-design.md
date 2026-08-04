# Two-part curriculum and lexicon alignment design

## Goal

Rebuild the tutorial around two pieces of homework. Part 1 teaches one agent at a time and runs
everything by hand; Part 2 joins those agents into an assembly line that runs itself. Along the
way, adopt the course lexicon so the tutorial teaches the shared vocabulary rather than a parallel
one.

Two problems motivate this. The tutorial currently opens by asserting that "every factory is built
around a validation loop" and showing the loop diagram before the learner has run anything, so the
central idea arrives as a claim rather than as something they built. And the tutorial's own
vocabulary has drifted from
`workshops/docs/materials/lexicon.md`: it says *reviewer* where the lexicon says *validator*, still
says *worker* and *agent A* in places, and uses *iteration* for a curriculum unit where the lexicon
reserves that word for a batch of agent work.

## Curriculum shape

Six lessons in two parts. Each lesson in Part 1 teaches exactly one agent with one job to be done.
The word *factory* is withheld until Part 2, because a factory is the thing you get by joining
machines, and the learner should join them before naming the result.

### Part 1 — The validation loop

| Lesson | Goal | Builds |
| --- | --- | --- |
| 001 | Run an agent headlessly | one command, no files |
| 002 | Build a doer | `refactor.md`, `refactor-do.sh` |
| 003 | Build a validator | `refactor-validate.md`, `refactor-validate.sh` |
| 004 | Feed the findings back | no new script; a hand-run cycle |

### Part 2 — Build the factory

| Lesson | Goal | Builds |
| --- | --- | --- |
| 005 | Join them into an assembly line | `factory/refactor/`, `run.sh`, `success.md` |
| 006 | Route failed verdicts to repair | a branch in the line's `run.sh` |

## Lesson 001: Run an agent headlessly

The learner writes no files. They run one command, read the answer, then run it again without `-p`
to feel the difference:

```sh
echo "Describe what this calculator does, in three sentences." \
  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
```

This lesson defines two terms and demonstrates both in the same command. An **agent** is a harness
with a job to be done: Pi is the harness, and the text on stdin is the job. **Headless** means no
human is in the conversation while it works, which is what `-p` selects and what the lexicon calls a
*machine*. The lesson names the harness and the job but not the machine — that word belongs with the
assembly line in Part 2.

The read-only toolset is the third teaching beat: `--tools` is the boundary, and the learner will
draw a different boundary for each of the next two agents.

The lesson has no `factory/` artefact and no `run.sh`, so its check is that the learner can quote
what the agent said and explain which part of the command was the job to be done.

## Lesson 002: Build a doer

This is the current lesson 001 with `success.md`, the loop diagram, and the "you are the reviewer
for now" framing removed. Without shared criteria yet, `refactor.md` states the doer's job to be
done directly: choose one small, behaviour-preserving refactoring and edit the files.

`refactor-do.sh` captures a quality baseline before it invokes Pi:

```sh
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "Recording quality baseline..."
(cd ../calculator && node scripts/quality.mjs) > refactor-quality-before.txt || true
echo "Starting doer..."
cat refactor.md | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
```

The baseline exists because lesson 003's validator needs a *before* number to compare against. It
also earns its place as teaching: the lines around the Pi call are deterministic code wrapping a
model call, which is what makes this a harness rather than a command. `node scripts/quality.mjs`
rather than `npm run quality` follows the calculator's README, which warns that npm's own error
block on a non-zero exit reads like the script broke.

Every step the harness takes announces itself, not only the Pi invocations. The existing rule that
each Pi call needs a preceding `echo` identifying its role widens here: a learner watching the
terminal should be able to name what the harness is doing at each moment, and a silent capture step
is exactly the kind of thing that later looks like magic.

The doer gets no `bash` tool. It cannot check its own work, which is the point.

## Lesson 003: Build a validator

The learner writes `refactor-validate.md` and `refactor-validate.sh`, then runs the validator by
hand whenever they want. Nothing chains it to the doer.

The validator's prompt is deliberately simple. Its job to be done is narrow enough to state in one
sentence — was the change a single refactoring, and did it reduce what `node scripts/quality.mjs` reports
against the recorded baseline? — and its response format is a verdict plus evidence:

```text
VERDICT: PASS

EVIDENCE:
- <what you ran, what it reported>
```

Handing the learner a polished validation prompt here would teach nothing; they would copy it. A
naive validator that knows one check is something they can see the limits of, and those limits are
what lesson 005's `success.md` answers.

The validator gets `read,grep,find,ls,bash` and no `edit` or `write`. Its prompt forbids
file-modifying shell commands. That access boundary, opposite to the doer's, is the lesson's second
teaching beat: independent evidence requires an agent that did not do the work.

`refactor-validate.sh` tees the verdict to `refactor-validate-findings.txt` as well as to the
terminal, so lesson 004 has something to hand back without retyping it. If the baseline file is
missing because the learner has not run the doer yet, the script says so and stops rather than
inventing a comparison.

## Lesson 004: Feed the findings back

No new files. The learner runs a cycle by hand: run the validator, read a `VERDICT: FAIL` with its
evidence, paste that evidence into the doer's stdin alongside `refactor.md`, run the doer again,
re-validate.

```sh
cat refactor.md refactor-validate-findings.txt \
  | (cd ../calculator && pi --no-session --tools read,edit,write,grep,find,ls -p)
```

The same two agents produce a different result because the context changed, and nothing else did.
That is the whole idea of the validation loop, arrived at by doing rather than by diagram. Only now
does the tutorial show the doer-validator loop as a picture, as a summary of what the learner just
ran.

The lesson ends Part 1. Its pressure test is the copy-paste tax: the learner has just been the
orchestrator, deciding what runs next and carrying evidence between turns, and it does not scale
and cannot be left alone.

The tutor marks Part 1 complete here, recaps what was built, states that this is the end of the
first homework, and offers a choice between stopping and continuing. A learner with momentum is not
blocked; a learner working to an assignment has an unmistakable boundary.

## Lesson 005: Join them into an assembly line

The lesson opens with a move, not a new file:

```sh
mkdir factory/refactor
mv factory/refactor-do.sh factory/refactor/do.sh
mv factory/refactor-validate.sh factory/refactor/validate.sh
```

The prompts move alongside, and the `refactor-` prefixes drop because the folder now carries the
line's identity. Then the tutorial names what the learner just drew a boundary around: an
**assembly line** is an ordered sequence of **machines**, each machine's output feeding the next,
and a **factory** is the software containing one or more lines. A second line would be a second
folder — which is why the line needed an edge before it could be named.

`factory/refactor/run.sh` runs the doer, then the validator, then pauses, repeatedly. It prints the
verdict and stops for the learner between passes.

`success.md` arrives in this lesson and for this reason: the naive validator knew one check, which
was enough while a human read every verdict, but a line that runs unattended needs criteria that
outlive a single turn. The learner writes what a well-factored calculator looks like, defaulting to
Kent Beck's four rules of simple design, and names evidence a validator can quote for each. Both
prompts then read `success.md` instead of carrying their own criteria.

## Lesson 006: Route failed verdicts to repair

The current lesson 004, renumbered. `run.sh` parses the verdict, and a `FAIL` routes the findings
into a repair turn instead of the next refactoring.

This is lesson 004 done by the line rather than by the learner, and the lesson says so. The graph
branches, which is the first time the assembly line is not a straight sequence.

## Ledger and engine changes

`docs/specs/README.md` gains a heading and a table per part:

```markdown
## Part 1 — The validation loop

| Lesson | Goal | Status |
| --- | --- | --- |
| [001](001-run-an-agent-headlessly.md) | Run an agent headlessly | Todo |
...

## Part 2 — Build the factory

| Lesson | Goal | Status |
| --- | --- | --- |
| [005](005-join-them-into-an-assembly-line.md) | Join them into an assembly line | Todo |
...
```

`readProgress` in `tutorial-engine/src/lesson/load.ts` learns two things: it recognises `## Part N —
<title>` headings and emits a group item so the sidebar renders parts as sections, and its header
filter changes from the literal `"Iteration"` to `"Lesson"`. `ProgressItem` gains an optional
`part` field, and the web sidebar renders a heading wherever it changes. `tutorial-engine/test/lesson-load.test.ts` covers both the
two-table ledger and the renamed header cell.

The tutor's system prompt in `tutorial-engine/src/agent/pi-adapter.ts` stops saying *worker*: "another
worker CLI" and "the worker requirements" become *doer*, and "Do not act as the factory worker"
becomes "Do not act as the doer". The prompt also gains the Part 1 completion beat.

## Lexicon alignment

The rename runs across prose, the tutor prompt, the engine, and the evals.

*Reviewer* becomes **validator** everywhere, in prose and in identifiers. The artefacts follow:
`review.md` becomes `refactor-validate.md` and then `validate.md`, and `"Starting review..."`
becomes `"Starting validation..."`. The lexicon lists *reviewer*, *critic*, *verifier*, and *agent
B* as industry and legacy names for the role it calls validator; the tutorial should teach the
canonical one.

*Worker* becomes **doer**, in the tutor prompt, in `evals/harness/assertions.ts`, and in `TODO.md`.
*Agent A* and *agent B* in `README.md`, `docs/specs/001-*.md`, and
`tutorial-engine/docs/plans/iterations/001-base/plan.md` become doer and validator.

*Iteration* as a curriculum unit becomes **lesson**, matching `evals/scenarios/lesson-00N/`, the
root README, and `tutorial-engine/src/lesson/`. The word is then free for the lexicon's meaning, a
bounded batch of agent work, which is what the loop lessons' Enter prompt now names. The scripts'
phase echoes say `"Starting doer..."` and `"Starting validation..."`: each announces the machine
about to run, and the iteration is the pass around them rather than any one line of output.

**Machine**, **assembly line**, and **orchestrator** enter the tutorial in Part 2 only. Each Pi
invocation in the line is a machine, `factory/refactor/` is an assembly line, and `run.sh` decides
what runs next. Part 1 avoids all three, because a learner who has not yet joined anything has no
referent for them.

`.pi/skills/ensemble-review/SKILL.md` describes an ensemble of **validators**. Three models review
the same single file against the same criteria, which is the validator role by the lexicon's
definition; there are no competing candidates, so the *judge* role does not apply. The skill's prose
adopts *validator* for the three reviewing models. Its synthesis step — comparing the three reports
and weighing which voice to trust — has no lexicon term today, and the skill can keep describing it
in its own words rather than forcing a fit. The skill name and its `/ensemble-review` invocation
stay as they are; renaming a working command earns nothing.

The historical design documents under `docs/plans/`, including the two
`provider-agnostic-worker` files, keep their current vocabulary. They record what was decided when,
and rewriting them serves no reader. `tutorial-engine/docs/plans/iterations/` keeps its path for the
same reason, apart from its `agent A` reference.

## Evals

`evals/harness/assertions.ts` asserts on exact script text, exact Pi argument lists, and exact echo
strings, so every artefact rename and every script split lands there. It gains assertions for the
new lesson 001, the `refactor-do.sh` and `refactor-validate.sh` split, the lesson 005 folder move,
and the quality baseline file.

`evals/scenarios/` gains `lesson-001` for the headless lesson, and the existing directories shift:
`lesson-001` to `lesson-002`, `lesson-002` to `lesson-003`, `lesson-003` to `lesson-005`, and
`lesson-004` to `lesson-006`. A new `lesson-004` covers the hand-run feedback cycle. Because lesson
004 produces no artefact, its scenarios assert on what the tutor taught rather than on what the
learner built, which the model-graded judge in `evals/harness/judge.ts` already supports.

`evals/harness/factory-stubs.ts` and `evals/test/factory-stubs.test.ts` follow the script renames.

## Compatibility

There is no learner state to migrate. `factory/*` is gitignored apart from `.gitkeep`, so no
committed artefact changes name, and a learner resuming a saved transcript from the old curriculum
would find their `factory/` contents inspected fresh by the tutor as resume already does.

The lesson count changes from four to six and the ledger gains headings, so the engine change and
the ledger change must land together. Everything else — the specs, the tutor prompt, and the evals —
can land incrementally behind them.
