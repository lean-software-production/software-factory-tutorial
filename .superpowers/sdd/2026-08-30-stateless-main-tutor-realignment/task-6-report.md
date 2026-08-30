# Task 6 report — three automatic attempts then fatal

## Result

Task 6 is complete in two commits:

- `3b8b7a1 Replace tutor retry lifecycle with fatal state`
- `84bf171 Remove manual tutor recovery surfaces`

## Fixed retry boundary

Every Pi Tutor prompt and compaction operation now uses the same fixed adapter policy: exactly three
provider attempts. Per-operation attempt overrides and `terminal-review-policy.ts` are gone. Exhaustion
raises `TutorInfrastructureError`; provider details remain private.

The workflow converts an exhausted Tutor operation into one learner-safe, process-local fatal state. The
state tells the learner to fix or reconnect the provider and restart the workbook. Once latched, it blocks
messages, editor/event submission, terminal assessment, continuation, introduction completion, and other
mutating commands. It is neither appended to `events.jsonl` nor reconstructed after restart.

Terminal review still rejects stale results by attempt identity. Logs retain only privacy-safe operation,
duration, outcome, and retry-count telemetry; provider exceptions, evidence, request identifiers, and
attempt identifiers do not enter the public state.

## Removed lifecycle

The implementation no longer has:

- terminal review request or failure events;
- `tutor_failed` domain or public timeline records;
- failure-as-feedback projection;
- retry request IDs or retry fields in public terminal state;
- a manual retry workflow method, HTTP route, browser request, handler, prop, or button;
- restart-time pending Tutor-effect discovery or requeue;
- the obsolete workflow retry test suite.

Current terminal lifecycle projection uses submitted, finished, checking, feedback, and accepted facts.
The evaluator fixtures, private-to-public projections, reports, and documentation now use that current
vocabulary while continuing to prove that raw evidence and private lifecycle data do not reach judges or
reports.

The browser no longer renders persisted Tutor failure cards or retry controls. A minimal fatal notice and
mutation disabling are present; Task 9 will complete the accessible final fatal UI treatment and its
coverage.

## Verification

Focused fatal-state server tests prove that exhaustion latches once, returns no provider detail, leaves no
failure event, blocks later mutations without changing the timeline, exposes no retry route, and resets
only with a new server process. Projector and progression tests cover the reduced lifecycle. Adapter tests
cover the fixed three-attempt prompt and compaction policy.

```text
Production and test TypeScript: passed
Engine eval check: passed
Engine eval: 11 files, 72 tests passed
Root authored eval check: passed
Root authored eval: 12 files, 206 passed, 1 skipped
npm run --workspace=tutorial-engine test:fast:
  lint/typechecks/check:eval passed
  56 files, 592 tests passed
  web build passed
  browser smoke passed
```

## Concerns

Task 7 must apply this fatal mechanism to summary-before-completion ordering. Task 9 must finish and test
the prominent accessible fatal banner and ensure every browser mutation surface is visibly disabled.
