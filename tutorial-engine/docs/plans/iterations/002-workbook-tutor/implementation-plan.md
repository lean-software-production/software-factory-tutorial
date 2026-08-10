# Workbook tutor implementation plan

## Purpose

Build the workbook tutor beside the existing browser tutor, migrate one lesson at a time, and use Matt's
play-tests and curriculum review to decide what the next lesson needs. The legacy tutor remains the
default working path until a workbook lesson is accepted.

This plan implements the design in [the workbook specification](spec.md). This iteration delivers lesson
001 only. The lesson-by-lesson migration after its play-test is a roadmap, not scope for this iteration.

## Delivery rule

Each migrated lesson is a vertical slice:

1. A human prepares and reviews its workbook content.
2. The workbook engine renders that content and its required block types.
3. Matt play-tests it in a learner workspace.
4. The resulting fixes land before the next lesson migrates.

Lesson 001 is first. Lesson 002 is second because it introduces learner file changes and therefore the
filesystem watcher. Do not begin a later lesson merely because its prose can be mechanically copied.

## Workstream A: run both tutors safely

### A1. Preserve the legacy tutor

Keep `npm run tutorial` and `tutorial-engine/` working as they do today. Do not replace its server,
browser client, session log, or progress store during this iteration.

Add a separate workbook entry point, exposed at the repository root as:

```sh
npm run tutorial:workbook
```

Build the workbook as an isolated entry point inside `tutorial-engine/`: server and CLI modules under
`src/workbook/`, plus a separate `web-workbook/` Vite app that builds to `dist/web-workbook/`. Its Vite
output must differ from the legacy `dist/web/` output so either build cannot remove the other bundle. Do
not refactor shared code merely to remove duplication before the first play-test establishes what should
be shared.

### A2. Isolate state and ports

The workbook server binds to loopback and chooses an available port by default. It writes only to:

```text
factory/.tmp/workbook/
```

That namespace contains the workbook's append-only event log and an optional rebuildable projection
cache:

```text
factory/.tmp/workbook/events.jsonl
factory/.tmp/workbook/projection.json
```

The workbook server is the event log's single writer. The cache never becomes the authority: deleting it
and replaying `events.jsonl` must restore the same learner progress. The workbook must never write the
legacy tutor's transcript or progress files.

The two engine versions may run side-by-side. They keep separate state and do not coordinate mutations of
learner artifacts in `factory/` or `calculator/`; play-tests that need isolation use a copied workspace.
No cross-engine workspace lease is required for this iteration.

### A3. Acceptance checks

- Both root commands start independently on different available ports.
- Starting or completing workbook lesson 001 leaves legacy state unchanged.
- Starting the legacy tutor leaves workbook state unchanged.
- Replaying workbook events rebuilds the same progress projection.
- Legacy and workbook sessions can run on separate ports without sharing engine state.

## Workstream B: workbook shell

### B1. Continuous document and navigation

Render one document containing the migrated lesson chapters. The left rail lists every lesson, grouped by
part. Before a lesson migrates, its rail row is an explicitly unavailable chapter stub: it is not presented
as readable ahead narrative and it has no local block outline. A chapter is selected for navigation by a
deterministic reading line, not by arbitrary viewport overlap:
the chapter whose heading most recently crossed the upper reading line is the viewed lesson. At the top
and bottom of the document, select the first and last chapter respectively.

Only the viewed lesson expands in the rail. Its local block outline is visible; other lesson rows remain
collapsed. Clicking a lesson changes document position and the viewed lesson only. It never changes
curriculum progress.

Persist curriculum progress through workbook events only. Viewed location is transient client state. On
resume, scroll to the active block in the active lesson, as specified; do not infer progress from the
restored position.

### B2. Workbook treatment

Implement the editorial workbook baseline before adding complex blocks:

- squared-paper document field and notebook margin;
- spacious vertical rhythm and large serif narrative type;
- a persistent, accessible left rail;
- visible but high-contrast ahead-of-progress treatment;
- keyboard, selection, search, and screen-reader access to readable ahead narrative.

Do not use opacity or a translucent overlay in a way that makes text fail contrast requirements. The
learner's progress state must be available semantically even if the visual design does not print an
intrusive status label.

### B3. Acceptance checks

- The rail changes expansion deterministically at chapter boundaries.
- A learner can scroll ahead without changing availability or progress.
- An ahead chapter remains readable, selectable, keyboard reachable, and announced with its state.
- Mobile navigation remains usable without depending on hover or a wide sidebar.

## Workstream C: minimum executable lesson contract

### C1. Contract before watcher

Before implementing learner observation or progressive release, define and validate the smallest real
contract needed by lesson 001. It may evolve, but it must use ordered block instances rather than an
array of type names.

Every block instance needs a stable ID and type. The contract also needs enough information to render its
authored source and to persist its progress. Interactive blocks add only the fields their type needs.
For example, a terminal-practice block needs its displayed command, terminal context, expected
observation, learner acknowledgement, and attached help actions. For lesson 001, prerequisites are
strictly sequential: an activity becomes ready when its immediate required predecessor completes.

Keep key concepts and learning outcomes as authored strings in YAML for now. Do not implement taxonomy
IDs, schema versioning beyond what validation needs, or a general block language for future lessons.

### C2. Event store and minimal state model

Record append-only domain events such as `session_started`, `observation_acknowledged`,
`unexpected_output_submitted`, `quiz_answered`, `reflection_submitted`, `review_requested`,
`block_completed`, and `lesson_transitioned`. Record observable facts and explicit learner actions, not
guesses about unobserved terminal or editor work. `file_change_observed` arrives with lesson 002.

A pure projection replays those events into the current state. Implement and test a small deterministic
model that separates:

- **viewed lesson** — derived from scroll position and never persisted as curriculum progress;
- **active block** — the next required learner activity;
- **ready block** — an activity whose prerequisites have been met;
- **completed block** — an activity with its required evidence recorded; and
- **lesson complete** — all required blocks completed and the learner has taken the lesson transition.

The event log is the source of truth for persisted progress; a projection cache is an optimisation only.
Narrative may be readable before it is reached. Consequential exercises are unavailable until their
prerequisites are met. A submitted quiz or reflection records participation, never correctness; it cannot
become a mastery gate.

### C3. Evidence channels

The lesson-001 contract starts with two explicit evidence channels:

- learner acknowledgement of an expected observation; and
- learner-submitted or pasted output when the observed result differs.

A terminal-practice block becomes active when its predecessor completes. An expected acknowledgement
records its observation and completes the block. Reporting different output records that evidence but
leaves the block active while the learner receives help and retries or explicitly acknowledges a resolved
observation. The engine never executes the learner's terminal command.

Filesystem predicates arrive with lesson 002. Restoration checks arrive with the first experiment lesson.
Neither belongs in the lesson-001 vertical slice.

### C4. Acceptance checks

- Malformed manifests fail with useful location-specific errors.
- Resume preserves active and completed block state without using scroll position.
- A reflection can be submitted incorrectly and still permit onward progress.
- A terminal exercise cannot claim to have observed output merely because an unrelated file changed.

## Workstream D: lesson 001 content and interaction

### D1. Human authoring work

Port lesson 001 from `docs/specs/001-run-an-agent-headlessly.md` into workbook source material. Preserve
the lesson's actual teaching sequence and its vocabulary boundary. The new material must contain:

- an opening orientation;
- clearly articulated key concepts;
- observable learning outcomes;
- fixed narrative explaining agent, harness, job to be done, headless operation, and boundary;
- the supplied headless command and the learner's own changed-job command, changed by replacing quoted
  standard input rather than by editing a file;
- expected observations and reflection questions;
- a pressure-test transition into lesson 002; and
- accessible text for any visual treatment used.

Lesson 001 does not need the filesystem watcher. It exercises the workbook shell, narrative, external
terminal-practice presentation, acknowledgement evidence, reflection, and lesson transition.

### D2. Contextual help

Author the anticipated controls and responses for each lesson-001 practice block: explain the command,
show the command again, describe expected output, and report a different result. Provide `Something else`
as a small local free-text request, bound to the current block rather than a persistent chat transcript.

Static authored responses should serve common requests. Model-backed fallback help receives only the
current block, its authored teaching context, and relevant learner-supplied evidence; it cannot reorder
the lesson or broaden into a general chat session.

### D3. Human review gate

A human reviewer signs off lesson 001 before play-test. Review against this checklist:

- concepts state mechanisms accurately and introduce no premature vocabulary;
- outcomes are concrete and observable;
- prose is concise, technically correct, and readable as an independent document;
- terminal commands, directory context, expected observations, and reflection prompts are correct;
- static help, fallback-help boundaries, and error paths are suitable;
- visual and ahead-state treatments have accessible equivalents; and
- the lesson ending creates the right expectation for lesson 002.

Record curriculum review in
`tutorial-engine/docs/plans/iterations/002-workbook-tutor/reviews/001-curriculum-review.md`. Record the
play-test, its issues, and the go/no-go decision in
`tutorial-engine/docs/plans/iterations/002-workbook-tutor/reviews/001-play-test.md`. Curriculum review is
repository work; learner progress continues to belong only in `factory/.tmp/`.

### D4. Play-test

Matt runs lesson 001 in the workbook tutor using the normal external terminal. Observe whether the page
makes the command, its purpose, expected result, and next action obvious without falling back to chat.
Record issues with navigation, pacing, prose, accessibility, contextual help, and resume behaviour.

Fix the accepted issues before migrating lesson 002.

## Subsequent-iteration roadmap: lesson 002 and filesystem observation

After this iteration closes and lesson 001 is accepted, port lesson 002 and add editor-practice support.

The watcher activates only while the relevant editor-practice block is active. It resolves the workspace
root, observes declared relevant paths, ignores `.git/`, dependencies, build output, and `.tmp/` unless
the block explicitly includes one, and debounces editor atomic-save patterns. When a block activates or a
session resumes, inspect the current relevant state before subscribing so an earlier save is not missed.

A detected learner change produces a quiet local confirmation and offers `Review my change`; it never
reviews automatically. The workbook records its own audited mutation events so its writes do not appear
as learner work; it does not depend on legacy tutor audit records.

Lesson 002 receives the same human authoring, review, and Matt play-test cycle as lesson 001.

## Subsequent-iteration roadmap: continue one lesson at a time

For each subsequent lesson:

1. Identify its required block types and any new engine capability.
2. Implement that capability with tests before or alongside the lesson that first needs it.
3. Produce the human-authored workbook draft: concepts, outcomes, narrative, interactions, exercises,
   evidence, and visuals.
4. Complete human curriculum review.
5. Play-test the lesson.
6. Correct the engine or content before proceeding.

Likely capability milestones include structural migration and distributed wiring (005), experiments and
closed evidence (006), branching and diagrams (007), stateful stopping conditions (008), records (009),
live observation and multiple-terminal guidance (010), record questions (011), and steering a running
station (012). Lesson 013 is synthesis and reflection rather than a new build capability.

## Test strategy

Keep legacy engine tests intact. Add workbook tests for:

- manifest loading and invalid-contract diagnostics;
- event-log replay, projection rebuild, progress state transitions, and resume;
- scroll-spy selection independent of progress;
- block availability and ahead-state accessibility;
- local help and absence of a global chat transcript;
- separate legacy and workbook state directories; and
- browser interactions for the lesson-001 vertical slice.

Add watcher path filtering, debounce, pre-existing changes, and learner-versus-tutor provenance to the
lesson-002 test plan rather than this lesson-001 iteration.

Use a copied fixture workspace for workbook tests and for any play-test that must run beside a legacy
session. Do not invoke real model calls in deterministic tests; model-backed contextual help has a
contract test and separately scoped live evaluation.

## Completion criteria for this iteration

The iteration is complete when:

- the legacy tutor remains usable through all thirteen lessons;
- the workbook tutor can run alongside it without sharing session state;
- lesson 001 is fully migrated, reviewed by a human, and play-tested by Matt;
- its workbook content, navigation, terminal-practice block, local help, progress, resume, and
  accessibility checks pass; and
- a decision has been recorded from the play-test before lesson 002 begins.
