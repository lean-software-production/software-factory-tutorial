# Software factory tutorial

## Writing lesson specifications

Lessons live in `docs/specs/NNN-*.md` and are read by two audiences: the coach agent, which
paraphrases them for the learner, and whoever maintains the curriculum. A specification that reads
well but describes the mechanism loosely produces a lesson explanation that is confidently wrong,
because the coach paraphrases faithfully.

**Name the mechanism, not a picture of it.** Every claim about what the line does should survive being
checked against the shell. Prefer the verb that actually happens — runs, appends, reads, writes,
deletes — over one that stands in for it. A sentence like "the harness gathers the evidence and
carries it to a machine that cannot reach for it" fails twice: nothing is *carried* (the output is
concatenated onto the prompt), and the validator's incapacity is not that it cannot *reach* existing
evidence but that it cannot *run the commands that produce it*.

Concretely, when writing a lesson's **Key concept**:

- **One figure of speech per sentence, at most.** Two stacked metaphors force the reader to resolve
  both before the claim lands. This is the single most common cause of a confusing payoff line.
- **The bolded payoff sentence is the highest-risk sentence in the file.** It is the one the coach
  quotes and the learner remembers, and its compression is exactly what invites metaphor. State the
  mechanism and its reason: *X does this, because Y can no longer do that.*
- **Say why, not just what.** A boundary lesson should name the capability that was removed and the
  consequence that follows, so the learner can predict the behaviour rather than recall a slogan.
- **Use the lexicon, and only what is already defined.** `machine`, `harness`, `doer`, `validator`,
  `orchestrator`, `station` and `line` have definitions — `machine` in lesson 005, for instance.
  Introducing a fresh noun for an already-named thing reads as a new concept. A later lesson's
  vocabulary belongs to that lesson.
- **Prose wraps at 100 columns**, matching the existing specs.

The `## What this costs` section exists to state a trade honestly. Do not soften it into a footnote:
both halves — the guarantee and the limitation — should be stated plainly enough that a learner could
argue with them.

## Learner state belongs in factory/.tmp/, never in the curriculum

`docs/specs/README.md` lists the lessons and nothing about any particular learner. How far someone has
got lives in `factory/.tmp/tutorial-progress.json`, beside the session transcript. Writing progress
back into the ledger would hand everyone who clones the tutorial a copy that claims to be part
finished, so the ledger's rows carry a specification link and a goal, and no status.

`factory/` sorts into three kinds, and the split is what `.gitignore` encodes:

- **The learner's line** — every `.sh` and `.md` they write — is **tracked**, so their own work
  survives a mistake and can be committed if they want it kept.
- **Everything else** goes in a `.tmp/` beside the script that writes it, and one rule —
  `factory/**/.tmp/` — ignores all of it. That covers the engine's state in `factory/.tmp/` and the
  evidence, findings, baselines, commit messages and iteration records a run regenerates. Committing
  those would churn the history every run.

So a lesson that writes anything a run recreates writes it to `.tmp/`, whatever its name or format.
Scripts `cd "$(dirname "$0")"` before doing anything, so the path is just `.tmp/evidence.txt`, and a
learner who builds a second line gets the same rule without a second `.gitignore` entry. A script that
writes there needs `mkdir -p .tmp` after its `cd`: `resetFactory` clears the directory away.

## The line commits to a branch of its own, one per session

From lesson 007 the line commits to the calculator, and from 008 it does so unattended. `calculator/`
has no repository of its own, so those commits land in the learner's clone of the tutorial. The engine
switches to `factory-line-<date>-<time>` when a session starts (`ensureLineBranch`), which keeps the
branch they cloned pullable and makes a run easy to throw away.

One branch per session, stamped to the minute, and each is cut from wherever the last one left off —
so the calculator keeps the work already done to it, and the branch a learner was on last week is
still there to go back to. It never fails a session over any of this: a workspace that is not a
repository still gets a working tutorial.

## Changing a Part 1 lesson means changing the Part 2 seed

`docs/seeds/part-2/` holds what lessons 002 to 004 leave in `factory/`, so a learner who chooses
"Start at Part 2" finds what lesson 005 expects to move. Change what those lessons have the learner
write, and change the seed to match — the two are the same artefact taught two ways.

`seed.test.ts` reads lesson 005's `mv` commands and fails if the seed does not supply every source
path they name. That catches a renamed file, not a rewritten one, so the content is still yours to
keep honest.
