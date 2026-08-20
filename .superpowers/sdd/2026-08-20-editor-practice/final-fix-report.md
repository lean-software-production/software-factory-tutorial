# Final review fixes: editor-practice

## Summary

Implemented all four final-review findings with regression coverage.

1. **Live browser refresh after async editor review**
   - Added bounded polling in the active editor component while the public status is `reviewing`.
   - Polls `/api/workbook/state` every 250ms for at most 480 attempts (120s), then stops.
   - Stops immediately when feedback/unlock/completion/inactive state is observed, and clears timers on unmount.

2. **Active editor draft restore in public state**
   - Server public state is now asynchronous and loads active editor draft data from `EditorDraftStore` first.
   - If no durable draft exists, it loads the declared target file contents; missing files initialize as blank revision 0.
   - `draftText` and editor revision are exposed only on the active, ready, incomplete editor block in `progress.blocks`.
   - Public lesson block data still strips private `tutor` fields.

3. **Restart-safe active editor revision/status**
   - After server restart, durable drafts reconstruct the active editor block as `editing` with the latest durable revision and text.
   - Same-revision submissions after restart are rejected as stale; the browser can submit the next revision.
   - Feedback remains volatile by design; revision/text do not become stale.

4. **Dedicated V2 editor review timeout**
   - Added `editorReviewTimeoutMs` to `V2WorkbookDriverOptions`.
   - Default editor review timeout is now 120s, independent of the 5s terminal timeout.
   - Per-call `submitEditorDraft(..., { timeoutMs })` still overrides the editor timeout.

## Regression tests added

- `tutorial-engine/test/workbook-server.test.ts`
  - Active editor target-file initialization when no durable draft exists.
  - Durable draft restore after server restart, stale rejection for old revision, and acceptance of next revision.

- `tutorial-engine/test/workbook-ui.test.tsx`
  - Active editor polls public state while review is in flight and refreshes on unlock.
  - Polling stops after completion and on unmount.

- `evals/test/v2-driver.test.ts`
  - V2 driver waits past terminal timeout using the dedicated editor review timeout.

## TDD evidence

The new regression tests were run before implementation and failed for the expected reasons:

- Server tests failed because public editor blocks lacked `draftText` and restored `revision`.
- UI tests failed because no `/api/workbook/state` polling occurred during `reviewing`.
- V2 driver test failed with `Timed out waiting for editor-practice review...` because it used the terminal timeout.

After implementation, the targeted suites passed.

## Verification

Fresh verification completed:

- `npm run --workspace=tutorial-engine test -- test/workbook-server.test.ts test/workbook-ui.test.tsx` — 32/32 passed.
- `npm run test:eval -- evals/test/v2-driver.test.ts` — 23/23 passed across eval tests.
- `npm run --workspace=tutorial-engine check` — TypeScript plus 208/208 tutorial-engine tests passed.
- `npm run check:eval` — evaluator TypeScript passed.
- `npm run check` — onboarding, evaluator checks/tests, tutorial-engine check, and calculator tests passed.
- `npm run --workspace=tutorial-engine build` — server/web/workbook builds passed; existing Vite chunk-size warnings remain.

## Self-review

- Active editor text is only emitted in `progress.blocks` for the active, ready, incomplete editor-practice block.
- Private `tutor` content remains excluded from public lesson state and was covered by existing/new privacy assertions.
- Durable draft is preferred over target file contents, preserving stale-revision semantics.
- Completed/unlocked editor blocks do not expose `draftText`.
- Polling is bounded and cleans up timers on completion/unmount.

## Notes / concerns

- Reviewer feedback remains in memory only and is not reconstructed after restart, matching the final-review allowance.
- Build output includes pre-existing Vite chunk-size warnings; no build failures.
