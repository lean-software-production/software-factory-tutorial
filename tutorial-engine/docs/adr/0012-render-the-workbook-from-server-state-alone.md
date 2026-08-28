# 12. Render the workbook from server state alone

Date: 2026-08-28

## Status

accepted

## Context

The browser client carried two rendering paths. `App` branched on `hasTimeline`, and the branch that
ran when a state arrived without a timeline rendered a separate presentation built from
`WorkbookIntroduction`, `PartChapter` and `LessonView`.

That second path could not run. The server sets `timeline` on every public state it builds, so the
condition was always true. But `PublicWorkbookState` declared the field optional, so nothing said so,
and roughly a third of `workbook-ui.tsx` stayed compiled, type-checked and covered by tests for a
presentation no learner could reach. Every change to the live path had to be made twice, and the
suite reported health for code that never ran.

Separately, `App` kept presentation state the server did not describe. Two refs remembered which
blocks had held a scroll runway, and the render body mutated them while rendering. React does not
promise a render is committed, so a discarded render consumed the transition; a reload, having no
memory of an earlier render, dropped the runway entirely and lost about a viewport of scroll height.
Both problems have the same shape: the browser deciding something the server already knew.

## Decision

Make `timeline` a required field of `PublicWorkbookState`, validated by `isPublicWorkbookState`, and
delete the unreachable branch and every component only it could reach.

Derive presentation state from the state snapshot instead of remembering renders. The scroll runway
is now `scrollRunwayBlockIds(state)`, a pure function over `progress.blocks`, `workAccepted` and
`workAcceptedBlocks` — all already on the wire. The refs are gone, no ref is written during render,
and `main.tsx` wraps the app in `StrictMode`.

The browser holds no presentation memory the server cannot reconstruct.

## Consequences

There is one rendering path, so a change to the workbook UI is made once. `workbook-ui.tsx` lost the
introduction, part, lesson-view, narrative, reflection and accepted-checkpoint components, and seven
tests that only described them.

A reload now lands on the same layout as the promotion that preceded it, which was a real defect
before and is now a property of the design rather than of luck.

The cost is that presentation questions must be answerable from public state. When one is not, the
answer is to put it on the wire deliberately, not to reintroduce a ref. Note that the readiness
projection was examined for this and deliberately not changed: making a block stay in `readyBlockIds`
until completion would have put the active block in it and rendered two runways.

`StrictMode` is worth having but is not what guards this. Double-invoked render does not reproduce
the discarded-render failure, and the old code survived it; the test that pins the behaviour is the
one that asserts a fresh load still shows the runway.
