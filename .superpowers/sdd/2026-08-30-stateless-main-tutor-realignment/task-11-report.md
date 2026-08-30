# Task 11 report — lifecycle eval and documentation cleanup

## Result

Task 11's implementation is in `7b23b71 Document stateless tutor lifecycle`; the following report commit records its result.

## Deterministic lifecycle coverage

The current server lifecycle suite now names and proves current-format reconstruction explicitly. It
checks the required `workbook-session-format` header, reconstructs the persisted submitted/finished
terminal attempt, keeps the public block in Checking, and proves a restarted server starts no pending
Main Tutor review. Existing deterministic coverage also proves current-format completion ordering,
stateless sessions, fatal provider exhaustion, stale result rejection, no retry route/events, and clear
unsupported-session rejection.

Engine and authored evaluator fixtures use only the current submitted -> finished -> feedback/accepted
terminal lifecycle. The Task 1 editor evaluator correction remains: learner-visible editor feedback is
read from `checkpoint.feedback`.

## Current documentation

The tutorial-engine README now documents:

- one model-backed workbook role, the Main Tutor;
- a fresh restricted Pi session for every operation, rebuilt from the versioned event log;
- ADR 0006 authored/detail/block-summary/lesson-summary history semantics;
- workspace tools only during active editor/terminal practice;
- exactly three automatic provider attempts, then process-local fatal state and restart;
- no manual retry, failure event, pending-effect resume, or old-session migration;
- summary-before-completion ordering; and
- the canonical visual command and two combined feedback composites.

Both evaluator READMEs distinguish the one stateless workbook Tutor from the evaluator-only Judge, state
the one-clean-run release rule, and describe the current fatal/no-manual-retry lifecycle.

## Benchmark artefact

`tutorial-engine/docs/plans/2026-08-30-main-tutor-direct-review-playtest.md` was deleted. Its concise result
remains in the Yak context rather than the product repository: `openai-codex/gpt-5.6-luna`, n=10, median
2.878s, p95 6.470s, 0% retries, 4 accepted/6 feedback, and 0 contradictions. No faster-model follow-up is
needed.

Historical plans and superseded ADRs were not rewritten.

## Verification

```text
Current-format restart/no-resume server test: passed
Engine eval check: passed
Engine eval: 11 files, 72 tests passed
Root authored eval check: passed
Root authored eval: 12 files, 206 passed, 1 skipped
npm run --workspace=tutorial-engine test:fast:
  lint/typechecks/check:eval passed
  55 files, 596 tests passed
  web build passed
  browser smoke passed
```
