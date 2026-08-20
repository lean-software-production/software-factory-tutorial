# V2 live evaluator design

## Purpose

Replace the legacy evaluator with a live evaluator for the v2 workbook tutor. It must exercise a
real tutor model and a real judge model, but run against a dedicated evaluation workbook rather
than the authored curriculum.

## Scope

The legacy evaluator is not a supported product and does not need a compatibility lane. Its source,
scenarios, and root-check integration may be removed after the v2 evaluator provides equivalent
coverage of the live evaluation path.

`npm run eval` remains the explicit, model-costing command. Root `npm run check` remains
deterministic: it typechecks and unit-tests evaluator code but does not call a model.

## Evaluation workbook

Store a small v2 Markdown-manifest workbook under the evaluator's own fixture tree. It contains
only the blocks needed to evaluate tutor mechanics:

- a narrative block that requires continuation;
- a terminal-practice block with a learner-visible command and private tutor guidance;
- a terminal-practice block that supplies clues instead of an insertable command;
- a reflection block with a learner-visible question and private tutor guidance;
- a lesson transition.

The workbook must be isolated from the real lessons, calculator, and learner workspace. Its shell
commands create and inspect disposable files inside its temporary evaluation workspace.

## Live session driver

The evaluator starts the v2 workbook server against a temporary copy of the evaluation workbook.
It drives the learner journey through the workbook HTTP and WebSocket interfaces, rather than a
real browser:

- reads public workbook state and verifies private tutor fields are absent;
- uses the embedded-terminal WebSocket to submit terminal input and collect its transcript;
- submits continuation and reflection actions through the workbook API;
- records public state transitions, terminal transcript, reflection messages, and server events.

The server uses the real tutor model for terminal observation and reflection facilitation. The
session driver must not replace those calls with test doubles in the live command.

## Scenarios and judgement

Each scenario starts from a clean temporary evaluation workspace and declares its learner actions,
expected public-state milestones, and judge criteria. Scenarios cover successful terminal practice,
failed or unexpected terminal output, a clue-only task, a reflection requiring follow-up, and
completion through a transition.

After a session, the evaluator passes the recorded transcript and scenario criteria to a second,
real judge model. Deterministic assertions gate protocol integrity first; the judge evaluates tutor
quality only after those assertions pass.

Reports retain the scenario, API/event trace, terminal transcript, judge result, model identities,
and workspace artifact snapshot.

## Scripts and migration

Replace the current `evals` TypeScript entrypoint and tests with v2 equivalents. Remove the legacy
server/session dependencies from `evals` and from root `npm run check`.

- `npm run check:eval`: typecheck v2 evaluator code.
- `npm run test:eval`: run deterministic v2 evaluator unit tests.
- `npm run eval`: build the workbook tutor, then run live model scenarios.

The new evaluator owns all v2 test-workbook fixtures and does not load real lesson content.
