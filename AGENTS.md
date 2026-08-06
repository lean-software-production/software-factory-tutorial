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

## Learner state belongs in factory/, never in the curriculum

`docs/specs/README.md` lists the lessons and nothing about any particular learner. How far someone has
got lives in `factory/tutorial-progress.json`, beside the session transcript: `factory/` is gitignored,
so one person's progress cannot be committed, and `resetFactory` clears it when they start over.

This is a rule about direction, not just about one file. Anything true of a single learner — progress,
their factory, their transcript — belongs under `factory/`. Anything the same for everyone belongs in
the repository. Writing progress back into the ledger would hand everyone who clones the tutorial a
copy that claims to be part finished, so the ledger's rows carry a specification link and a goal, and
no status.
