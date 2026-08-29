# Software factory tutorial

## Start here

- The repository root is the developer workspace: npm orchestration, setup scripts, evals, and the
  tutorial engine live here.
- The authored tutorial template is [`tutorial/`](tutorial/). Its [`README`](tutorial/README.md),
  `workbook.md`, `parts/`, `lessons/`, `docs/specs/`, `docs/seeds/`, and `workspaces/` move
  together. Treat this content as immutable during learner runs.
- Each learner session has private live workspaces at
  `tutorial/.tutorial/<session-id>/workspaces/<workspace-id>/`. Learner shell commands, edits, and
  commits happen in the active live workspace, not in the authored template and not in the
  repository root. A lesson may declare a lowercase ID such as `workspace: refactor-line`; the
  launcher copies `tutorial/workspaces/<id>/` and initializes that copy as its own Git repository.
- The root `npm run tutorial:workbook` command launches the workbook. By default it creates a fresh
  session and prints the session ID and workspace path. `npm run tutorial:workbook -- --session <id>`
  is the only way to reopen that ID; browser-tutor state is not resumed.
- Engine documentation starts in [`tutorial-engine/README.md`](tutorial-engine/README.md); durable
  engine architecture decisions live under [`tutorial-engine/docs/adr/`](tutorial-engine/docs/adr/).
- Historical plans live under `docs/plans/`, `docs/superpowers/plans/`, and
  `tutorial-engine/docs/plans/`. Do not rewrite their old paths to look current.

## Agent workflow

For implementation work, always use `superpowers:subagent-driven-development`. Work autonomously
through the approved plan, including implementation, review, verification, and branch handoff. Do
not pause for progress updates, routine clarifications, or choices that can be resolved from the
plan and repository. Ask Matt only when an irreversible or security-sensitive action requires his
consent, an external side effect needs approval, or a genuine product decision remains unresolved
by the plan and codebase.

## Tutorial-engine architecture decisions

Record durable tutorial-engine architecture decisions as ADRs in `tutorial-engine/docs/adr/`. ADRgen is
installed in the development container, not on the host: from the repository root run
`devcontainer exec --workspace-folder . bash -lc 'cd tutorial-engine && adrgen <command>'`. Keep
`tutorial-engine/docs/adr/README.md` indexed, and supersede accepted ADRs rather than rewriting them.
This convention does not apply to the tutorial curriculum or lesson specifications.

## Writing lesson specifications

Lessons live in `tutorial/docs/specs/NNN-*.md` and are read by two audiences: the coach agent,
which paraphrases them for the learner, and whoever maintains the curriculum. A specification that
reads well but describes the mechanism loosely produces a lesson explanation that is confidently wrong,
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
- **Use [`tutorial/docs/GLOSSARY.md`](tutorial/docs/GLOSSARY.md), and only what is already
  defined.** It lists every term the tutorial teaches and the lesson that introduces it, along with
  the words this tutorial
  deliberately does not use. Introducing a fresh noun for an already-named thing reads as a new
  concept. A later lesson's vocabulary belongs to that lesson, so check what a term's lesson number
  is before reaching for it. A new term means a new row there.
- **Prose wraps at 100 columns**, matching the existing specs.

The `## What this costs` section exists to state a trade honestly. Do not soften it into a footnote:
both halves — the guarantee and the limitation — should be stated plainly enough that a learner could
argue with them.

## Session state belongs under tutorial/.tutorial/<id>/, never in the curriculum

`tutorial/docs/specs/README.md` lists the lessons and nothing about any particular learner. The
workbook tutor keeps its event log, attempts, and learner workspace under
`tutorial/.tutorial/<session-id>/`, not in the authored curriculum. Writing progress back into the
ledger would hand everyone who clones the tutorial a copy that claims to be part finished, so the
ledger's rows carry a specification link and a goal, and no status.

Inside a live workspace, `factory/` sorts into three kinds, and the split is what `.gitignore`
encodes. Lessons that declare the same workspace ID share that live workspace and Git history;
files the learner writes are session-local work, and regenerated evidence belongs under a nearby
`.tmp/` rather than in the authored tutorial.

- **The learner's line** — every `.sh` and `.md` they write — is tracked by the session-local Git
  repository, so their own work survives a mistake inside that session and can be committed there.
- **Everything else** goes in a `.tmp/` beside the script that writes it. The product repository
  ignores authored example `.tmp/` paths and all of `tutorial/.tutorial/`, so regenerated evidence,
  findings, baselines, commit messages, iteration records, workbook state, and session-local Git
  history never churn the product history.

So a lesson that writes anything a run recreates writes it to `.tmp/`, whatever its name or format.
Scripts `cd "$(dirname "$0")"` before doing anything, so the path is just `.tmp/evidence.txt`, and a
learner who builds a second line gets the same rule without a second `.gitignore` entry. A script that
writes there needs `mkdir -p .tmp` after its `cd`: this curriculum's reset clears its learner work.
Existing ignored browser-tutor state under `tutorial/.tutorial/.tmp/` may remain on disk but is not
resumed or migrated by the launcher.

## The line commits to the session-local repository

From lesson 007 the line commits to the calculator, and from 008 it does so unattended. Those commits
land in `tutorial/.tutorial/<session-id>/workspaces/refactor-line/.git`, not in the cloned tutorial
repository. A plain `npm run tutorial:workbook` creates new live workspace repositories; `--session
<id>` reopens those same repositories so the learner can inspect or continue private history.

## Changing a Part 1 lesson means changing the Part 2 seed

`tutorial/docs/seeds/part-2/` holds what lessons 002 to 004 leave in the refactor-line live
workspace's `factory/`. Change what those lessons have the learner write, and change the seed to
match — the two are the same artefact taught two ways.

`seed.test.ts` reads lesson 005's `mv` commands and fails if the seed does not supply every source
path they name. That catches a renamed file, not a rewritten one, so the content is still yours to
keep honest.
