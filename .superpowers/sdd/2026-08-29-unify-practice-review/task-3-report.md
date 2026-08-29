# Task 3 Report: Stabilize editor feedback while review is pending

## Trace / root cause

Controlled RED tests pinned the bug at two ownership boundaries:

1. **Browser POST boundary:** `EditorPracticeBlockView` posted `{ blockId, revision, text }`, but then accepted every `postEditorDraft(...).then(refresh)` response. A delayed older POST response could call `refresh()` after a newer response and replace the UI with stale draft/review state.
2. **Server editor boundary:** `/api/workbook/editor` ignored the submitted `revision`. `AttemptStore` ordered editor attempts by server receipt time, so an older revision that arrived after a newer one could become the current attempt and later unlock/write stale text.
3. **Feedback ownership:** `AttemptStore.create()` superseded the previous feedback attempt and `markReviewing()` cleared feedback. The public projection therefore exposed only `status: "reviewing"` during a replacement review, and provider failure replaced actionable feedback with generic loading/failure copy.
4. **CodeMirror lifecycle:** the editor view was already mostly stable because the creation effect does not depend on `draftText`; the missing piece was to ignore feedback-only state refreshes without forcing a rebuild and to key the component by block id so retained feedback does not leak between editor blocks.

## Implementation

- Added client-revision handling to the editor POST path:
  - `/api/workbook/editor` passes optional numeric `revision` into workflow.
  - `submitEditor()` validates positive integer revisions and ignores stale submissions (`revision <= current.version`) by returning current state without creating a new attempt.
  - `AttemptStore.create()` can use a caller-supplied version so the server stores the browser revision, including gaps caused by reordered POST delivery.
- Added retained feedback semantics for editor attempts:
  - A new editor attempt carries prior actionable feedback in `retainedFeedback` while review is pending.
  - Public checkpoint projection emits `reviewing + feedback + reviewNotice: "Updating feedback…"` for retained feedback during replacement review.
  - Provider/promotion failures use `markReviewUnavailable()` so prior actionable feedback remains in `checkpoint.feedback` and the retry/failure status appears in `checkpoint.reviewNotice`.
  - Normal tutor feedback still replaces prior feedback atomically by clearing retained feedback.
- Stabilized UI response handling:
  - Editor POST promises now refresh only if they match the latest submitted revision and do not return an older revision.
  - Transport failures preserve retained actionable feedback and add retry status instead of replacing the card.
  - Feedback display separates actionable markdown from status/notice and adds a small local spinner for updating state.
  - Editor component is keyed by block id; feedback-only refreshes keep the existing CodeMirror node, focus, cursor, selection, and local draft.

## TDD RED evidence

### UI RED

Command:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-ui.test.tsx -t "editor"
```

Initial failures (expected):

```text
× keeps previous editor feedback visible with a subtle update status while a new review is pending
  expected ... to contain 'Name the acceptance marker...'; received '...Reviewing your latest revision…'
× replaces old editor feedback atomically only when latest feedback arrives
  expected ... to contain 'Old actionable feedback.'
× ignores stale editor POST responses when an older request resolves after a newer one
  expected refresh to be called 1 times, but got 2 times
× retains previous editor feedback with a retry status when a resubmission transport fails
  expected ... to contain 'Old actionable feedback.'; received '...Network unavailable.'
```

### Server RED

Command:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-server.test.ts -t "stale editor revision|retains prior editor feedback"
```

Initial failures (expected):

```text
× ignores a stale editor revision submitted after a newer one so only the latest can unlock
  expected tutor.reviews to have length 1 but got 2
× retains prior editor feedback while a newer review is pending and when that provider fails
  expected checkpoint.feedback to be 'Mention the factory acceptance marker.'; received undefined
```

## GREEN verification

Focused UI/server:

```sh
npm run --workspace=tutorial-engine test -- test/workbook-ui.test.tsx -t "editor"
# Test Files 1 passed; Tests 13 passed | 63 skipped

npm run --workspace=tutorial-engine test -- test/workbook-server.test.ts -t "stale editor revision|retains prior editor feedback"
# Test Files 1 passed; Tests 2 passed | 49 skipped

npm run --workspace=tutorial-engine test -- test/workbook-ui.test.tsx test/workbook-server.test.ts
# Test Files 2 passed; Tests 127 passed
```

Full check:

```sh
npm run --workspace=tutorial-engine check
# lint passed
# tsc --noEmit passed
# tsc -p tsconfig.check.json passed
# check:eval passed
# vitest: 55 files passed, 502 tests passed
# build:web:workbook passed
# browser:smoke passed
```

Note: one earlier full `check` run timed out in `evals/test/package-script-forwarding.test.ts` at the default 5s Vitest timeout; that same test passed standalone with `--testTimeout=15000`, and the subsequent full `check` passed.

## Files changed

- `tutorial-engine/src/workbook/attempts.ts` — optional attempt version, editor retained feedback, `markReviewUnavailable()`.
- `tutorial-engine/src/workbook/workflow.ts` — public retained-feedback/reviewNotice projection, stale editor revision guard, editor submit version propagation, review failure retention.
- `tutorial-engine/src/workbook/server.ts` — parse/pass editor revision.
- `tutorial-engine/src/workbook/public-contract.ts` — `PublicCheckpoint.reviewNotice`.
- `tutorial-engine/web-workbook/src/workbook-ui.tsx` — retained feedback UI, latest-revision POST guard, retry status, keyed editor component.
- `tutorial-engine/web-workbook/src/styles.css` — small editor updating status/spinner styles only.
- `tutorial-engine/test/workbook-ui.test.tsx` — delayed/pending feedback, atomic replacement, quiet debounce/out-of-order POST, failure retention, focus/cursor/draft preservation coverage.
- `tutorial-engine/test/workbook-server.test.ts` — stale revision and provider-failure retained feedback coverage.

## Self-review

- **Async ordering:** server ignores stale editor revisions before creating attempts; existing review finalizer still re-checks generation, active block, current attempt id, evidence kind, and block match before mutating state. UI also ignores late POST responses when a newer local revision has been submitted.
- **Stale unlock prevention:** accepted editor promotion still uses `promoteCurrentEditorAttempt()`, and stale attempts cannot be current. The new server test verifies an older revision submitted after a newer one does not start review or write stale text.
- **CodeMirror lifecycle:** creation effect still excludes `draftText`, `revision`, and feedback state, so feedback-only refreshes do not destroy the view. The component key resets only on editor block id changes to prevent retained-feedback leakage between blocks.
- **Scope control:** no terminal unification, no Practice Coach removal, no shared feedback-bar extraction. Styling change is intentionally local/minimal pending Task 6.

## Concerns

- `reviewNotice` is added to the public checkpoint contract but the structural runtime validator still only validates the broad public-state shape; this matches existing checkpoint validation looseness but could be tightened later.
- The first full check attempt hit an unrelated/default-timeout eval flake; rerun passed without code changes.
