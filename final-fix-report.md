# Final fix report

Root cause:
- `finishReview()` treated block-tutor readiness as a gate, so failed or invalid advisory readiness prevented authoritative main-tutor review.
- `outcome: "working"` left attempts in `reviewing`, and reflection follow-ups required a tutor turn, so a quiet working result blocked the next reflection message.
- The main workbook tutor created Pi sessions without resolving `TUTOR_MODEL`, unlike the documented tutor adapter and block tutor.
- Empty review feedback was converted into generic material feedback by `publicText()` instead of failing review retryably.

Fix:
- Readiness failures now record retryable failures and continue to `mainTutor.review()` with no readiness.
- Quiet working reviews mark the current attempt back to `working`; reflection follow-ups are allowed after any prior reflection turn, and the UI sends follow-up after learner-only quiet working state.
- Main tutor sessions now use `resolveTutorModel()` and pass `model`/`thinkingLevel` to `createAgentSession`.
- Empty material review feedback now throws; server review handling records retryable failure and neutral retry feedback.

Test evidence:
- `npm run test -- workbook-server.test.ts workbook-tutor.test.ts workbook-ui.test.tsx workbook-tutor-model.test.ts` — 59 passed.
- `npm run --workspace=tutorial-engine check` — tsc passed; 37 files, 283 tests passed.
- `npm run check` — onboarding/eval/tutorial-engine/calculator checks passed.

Fix commit SHA: `adbe61a07f1d267f587d4c33a9ad8521ea05d64e`.
